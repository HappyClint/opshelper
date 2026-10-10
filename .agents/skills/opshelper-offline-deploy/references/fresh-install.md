# 全新离线安装

优先依据当前仓库 `docs/guide/offline-amd64.md` 和本次发布 Compose 生成具体部署文档。发布 ID 和镜像标签以本次实际交付为准。目标目录必须是全新实例；检测到已有数据库或用户目录时转入升级流程，不重置。

## 文档中要给出的命令

- 目标机 `uname -m`、Docker 版本、Compose 版本检查。使用 Compose v2；命令可为 `docker-compose` 或 `docker compose`，不要误用 Python Compose v1。
- 外部 `sha256sum -c`，解压到指定空目录，内部 `sha256sum -c SHA256SUMS`。
- `docker load -i images.tar.gz` 和实际六个标签的架构核对。
- 复制 `.env.example` 到权限 600 的 `.env`，生成并填写数据库密码及首次管理员密码；数据库密码使用 URL 安全字符，管理员密码强度按当前 seed 要求核对。不要在最终回复贴出实际密码。
- 填写宿主 `DATA_ROOT_HOST`、非 root 运行 UID/GID、`stat -c '%g' /var/run/docker.sock` 的组 ID、监听 IP/端口及唯一项目名。
- 按当前数据结构建立 postgres、agents、config/opencode、users、backups 等目录。应用目录归属和运行 UID/GID 一致；postgres 根目录由 init 服务设置权限，不能对整套已用数据递归 chown。
- `docker-compose --env-file .env config --quiet`。
- `docker-compose --env-file .env up -d --no-build --pull never`。
- `docker-compose --env-file .env ps -a`、迁移日志、入口 health 检查及浏览器登录。

当前首次安装为 postgres-init → postgres 健康 → migrate → 显式 bootstrap（仅空数据库）→ api → worker/web → nginx。升级和恢复禁止运行 bootstrap 或 seed。以实际 Compose 为准，初始化服务 `Exited (0)` 是正常完成，不是服务故障。首次 admin 密码与既有 admin 密码重置是不同操作。

## 完整验收范围

从另一台内网电脑访问物理机实际入口；localhost 健康不证明 LAN 可达。按现场要求处理防火墙、SELinux 和 HTTP/HTTPS，不自动关闭安全策略。模型 URL 必须从 runtime 容器可达，容器内 `127.0.0.1` 不代表物理机。

管理员配置内网模型、智能体和用户分配后，验证真实问答、协作（本次有此能力时）、文件读写与任务执行。记录延迟任务/停机期间任务的实际策略，不承诺会自动补跑。

包只提供平台及已声明依赖。缺少 Docker/Compose、内网模型、额外 MCP 服务或自定义技能时具体列出，不声称所有业务均已就绪。
