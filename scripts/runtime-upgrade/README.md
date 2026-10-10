# OpenCode 1.x 升级验收

使用真实的 1.17.9 / 1.18.34 执行容器和隔离的 API、worker、web、nginx、PostgreSQL。模型和 MCP 服务由本地确定性 fixture 提供；不使用生产数据库、用户目录或模型密钥。默认测试网络禁止访问互联网。

先构建测试镜像（Docker 必须可用）：

```sh
docker build --platform linux/amd64 -t opshelper/opencode-runtime:1.18.34 deploy/opencode-runtime
docker build --target api -t opshelper/opencode-upgrade-api:validation .
docker build --target worker -t opshelper/opencode-upgrade-worker:validation .
docker build --target web -t opshelper/opencode-upgrade-web:validation .
python3 scripts/runtime-upgrade/run.py
```

需要本机已有 `opshelper/opencode-runtime:1.17.9`，以及 PostgreSQL 16、Node 22、nginx 基础镜像。运行器默认从 `HEAD` 构建基线 API，配合 OpenCode 1.17.9 生成受管配置和会话，再切换当前 API / runtime。已有升级前版本时，可用 `--baseline-ref` 指定其提交；此 fixture 的旧运行时固定为 1.17.9。

测试还将一个仅分配给 Alice 的旧智能体移至其私有源目录，验证升级后仍能装载。测试覆盖旧会话继续、队列、中文 SSE、主从及嵌套协作、primary 委派拒绝、Skill、MCP、模型重试与切换、附件、文件下载、提问、三种权限回复、实际进程取消、跨用户隔离、重启、定时执行和授权撤销。Web 校验为生产构建的 HTTP 渲染检查；不代表浏览器交互验收。

P1 回归要求在 1.17.9 创建的同一个历史会话中执行嵌套协作，检查原消息 ID、已有子会话旧通配 deny 及维护消息清理；另将智能体从 primary 改为 all，在同一个会话中再次委派，确认过时的具体 deny 已删除。会话分支回归检查此前上下文、选中消息的文本和附件草稿、原会话保留、分支再次分支、首条消息边界、历史附件及用户归属。完整升级验收共 26 项。浏览器中的点击、刷新和重新发送仍需另外验收。

报告位于运行器打印的 `.temp/opencode-upgrade-*/`。目录包含一次性测试口令，不应提交或分享。默认清理测试用户容器、Compose 容器和数据库卷，保留报告；`--keep` 仅供调试。端口 4340 必须空闲。若进程被强制终止，应只清理报告中记录的测试用户容器和对应 Compose 项目，切勿使用全局 Docker prune。

补充运行时检查：

```sh
OPENCODE_PROBE_IMAGE=opshelper/opencode-runtime:1.18.34 \
OPENCODE_PROBE_REPORT=.temp/opencode-network-disabled.json \
python3 scripts/runtime-probes/run-runtime-probe.py

# 使用已授权的 Ollama API key，经环境变量传入；不要写入 Git 或命令历史。
OPENCODE_PROBE_IMAGE=opshelper/opencode-runtime:1.18.34 \
OPENCODE_PROBE_REPORT=.temp/opencode-real-model.json \
npx tsx scripts/runtime-probes/real-model-probe.ts
```

真实模型检查需要环境变量 `OLLAMA_API_KEY`，调用 `gpt-oss:120b` 并验证独立文件读取、主从结果、重连、取消及状态持久化。
