# OpenCode 1.18.34 升级说明

> 历史 V1 验证资料。当前代码和执行镜像已切换到 OpenCode 2，以下 V1 协议探针不适用于当前版本，也不能用当前 Dockerfile 构建 V1 镜像。当前流程见 [V2 切换说明](opencode-2-migration.md)。

本次将默认执行镜像由 `opshelper/opencode-runtime:1.17.9` 升级到 `opshelper/opencode-runtime:1.18.34`，仍使用 OpenCode 1.x 的 REST / SSE 接口。版本来源：[官方 1.18.34 release](https://github.com/anomalyco/opencode/releases/tag/v1.18.34)。

新版默认只允许一层子智能体，本项目显式配置 `subagent_depth: 24`，与现有执行监控最多收集 24 个协作会话的边界一致。新版 task 会继承父会话的 deny 规则而省略 allow 例外，因此原来的 task 通配禁止会阻止嵌套协作。会话策略改为在只包含用户获配智能体的受管目录中明确禁止 primary 和内置智能体；每次发送前刷新会话 task 权限，兼容旧会话并防止角色变化留下旧允许项。未获配智能体不进入容器配置，不能被执行。

OpenCode 1.18.34 的会话 PATCH 会追加权限，无法移除旧 deny。API 在业务提示发送前检查当前会话及已有子会话；需要修复时，通过同步 `noReply` / `tools` 接口替换旧规则，再恢复非 task 权限并应用当前策略。这一步不调用模型，仅生成一个已知 ID 的空维护消息，验证成功后删除该消息，保留原会话及业务消息 ID。持久化的 metadata 更新记录支持请求中断后的重试，更新未完成时不发送业务提示。规则已符合策略时不重复追加。该替换接口的 `tools` 字段已被上游标记 deprecated，因此本实现固定并实测于 1.18.34，后续升级须复验。

显式启用 `experimental.continue_loop_on_deny`：拒绝的工具保持拒绝，让模型解释拒绝或采取其他行动，避免没有最终回答而触发平台人工恢复门禁。取消执行仍使用原有 abort 流程。

历史部署中已获配、保存在 `users/<userId>/agents/personal-*/` 的个人智能体可继续从该用户原目录装载；仅当共享目录没有同名源时兼容读取。不移动到共享目录，不搜索其他用户，拒绝符号链接，并继续核对内容 hash。

受管配置生成版本由 7 升为 8，避免复用旧快照。清单记录可委派的智能体键；只读挂载、独立认证、项目配置禁用、用户状态及工作目录边界保持原有实现。

## 部署

需要同时更新 API 和执行镜像。已有 `.env` 如果显式指定 `OPENCODE_DOCKER_IMAGE=opshelper/opencode-runtime:1.17.9`，必须修改为 `opshelper/opencode-runtime:1.18.34`；默认值更新不会覆盖显式配置。按照[源码部署](deployment.md)或[离线升级](offline-amd64.md)流程操作，保留数据库、用户工作目录和 `/state`。本次没有新增 Prisma migration、环境变量或种子数据；升级不运行 seed。

切换前让正在执行的会话结束，并备份平台数据库和完整数据目录。旧用户容器由现有配置与镜像一致性检查在后续启动时重建，不应提前删除用户数据。

## 回退

1.17.9 不识别 `subagent_depth`，不能仅把执行镜像改回旧版本。回退需要配套恢复旧应用镜像、原 `.env` 及切换前备份的数据库和数据目录。新版 OpenCode 可能迁移原生会话 SQLite 数据，因此应恢复完整状态备份；不要让旧二进制直接打开已经迁移的状态。

## 验证

可重复运行的隔离升级验收见 [测试说明](../../scripts/runtime-upgrade/README.md)。平台测试使用真实执行容器和确定性模型 / MCP；额外的真实模型检查验证模型实际读取文件和执行协作。二者不能替代生产切换后的现场验收。
