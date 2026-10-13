# OpenCode 2 隔离验收

验证固定版本 `@opencode/cli@2.0.27`。执行容器使用真实 OpenCode；模型和 MCP 使用确定性本地服务，不使用用户模型密钥。测试网络禁止访问互联网，使用独立数据目录、PostgreSQL volume、随机密码和 Compose 项目名。

在仓库根目录构建镜像，再运行：

```bash
docker build -t opshelper/opencode-runtime:2.0.27 deploy/opencode-runtime
docker build --target api -t opshelper/opencode2-api:validation .
docker build --target worker -t opshelper/opencode2-worker:validation .
docker build --target web -t opshelper-web:local .
python3 scripts/opencode2-validation/run.py
```

需要本机 `node`、Python 3.9+、Docker Compose v2；测试入口固定 `127.0.0.1:4340`，执行前确保端口空闲。`--keep` 保留测试环境用于调试；默认退出时清理本次容器和数据库 volume，按挂载目录核对归属，不清理其他部署。

覆盖首次配置、连续对话、队列与中文 SSE、模型切换、附件、文件产物、技能、MCP、单层与多层协作、角色变更、提问、权限同意/拒绝/自动授权、主任务与子任务取消、会话分支边界、跨用户隔离、容器/API 重启、调度和分配撤销。

报告保存在 `.temp/opencode2-validation-*/acceptance-report.json`，包含通过项和镜像 ID。失败诊断留在该目录 `command-error.log`；目录中的配置与日志可能包含测试凭据，不提交 Git。当前网页构建的 HTML 响应检查不代替浏览器视觉验收；真实模型连通性需在目标部署另测。

切换脚本保护测试：

```bash
python3 scripts/opencode2-cutover.test.py
```

测试默认预览、错误镜像阻断、未完成任务阻断和重复执行保护。实际开发实例的操作顺序见[切换说明](../../docs/guide/opencode-2-migration.md)。
