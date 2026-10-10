# 运行时验证工具

这些工具在一次性测试容器中验证 OpenCode 的配置边界、网络隔离、持久化、模型协作和用户备份。它们不属于部署入口；各项验证应针对自己的隔离测试环境运行。

```bash
node --import tsx --test scripts/runtime-probes/lib/runtime-request.test.ts
bash scripts/runtime-probes/user-backup.test.sh
```

Docker socket 默认使用 `/var/run/docker.sock`；使用其他运行时时，通过 `DOCKER_SOCKET_PATH` 显式设置自己的 socket 路径。验证输出默认进入忽略目录 `.temp/runtime-probes/`。

`run-runtime-probe.py` 不自动读取生产配置或凭据。如需检查模型配置，显式设置 `OPENCODE_PROBE_CONFIG`，必要时通过 `OPENCODE_PROBE_ENV_FILE` 提供对应环境文件。配置检查不会调用模型。

真实模型验证工具使用 `OLLAMA_API_KEY`，仅在用户主动运行时请求模型；凭据经环境变量传入，不能提交到 Git。不要将验证输出或临时目录作为可公开的业务资料。
