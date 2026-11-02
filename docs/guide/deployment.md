# 源码安装与更新

x86 离线物理机部署请使用[离线部署文档](offline-amd64.md)和发布包内的 Compose 配置，直接执行 `docker load`、`docker-compose` 命令，无需部署脚本。下文用于持有源码的开发机及既有 `scripts/opshelper.py` 部署。

当前版本面向全新单机部署。保持 TypeScript / Fastify / Next.js / PostgreSQL 16 / Docker；每用户一个固定 OpenCode 2.0.27 容器。管理员分配智能体，用户可使用个人对话、文件和定时任务，并可在工作台创建智能体。

## 从空目录安装

前提：Docker Engine 或本机兼容运行时、Docker Compose v2、Python 3.9+、Bash。执行安装的用户需要访问 Docker socket。业务目录使用该用户 UID/GID；跨机器恢复时保留相同 UID/GID。

在仓库根目录构建镜像：

```bash
docker build --target api -t opshelper-api:local .
docker build --target worker -t opshelper-worker:local .
docker build --target web -t opshelper-web:local .
docker build -t opshelper/opencode-runtime:2.0.27 deploy/opencode-runtime
```

源码部署若复用已加载的镜像，须先将 `.env` 中各镜像变量设为实际标签，并跳过构建。离线发布约定见[离线部署文档](offline-amd64.md)。

```bash
python3 scripts/opshelper.py init --project opshelper --port 8080
python3 scripts/opshelper.py bootstrap
python3 scripts/opshelper.py up
python3 scripts/opshelper.py status
python3 scripts/opshelper.py down
```

`init` 拒绝覆盖已有 `.env` 或非空数据目录。它在当前部署目录生成 `.env` 和 `data/`，写入宿主绝对路径、当前 UID/GID、随机数据库密码和随机管理员密码。配置文件权限为 600，不输出密码。账号为 `admin`，初始密码查看本机 `.env` 的 `OPSHELPER_ADMIN_PASSWORD`。不创建演示用户。`bootstrap` 仅允许空数据库；已有任意业务数据时拒绝运行。升级、重启和恢复不运行 seed，也不会重置管理员密码。

默认访问 `http://127.0.0.1:8080/`。新目录也可以显式指定：

```bash
python3 scripts/opshelper.py --env-file /absolute/deployment/.env init --project opshelper-new --port 8081
python3 scripts/opshelper.py --env-file /absolute/deployment/.env bootstrap
python3 scripts/opshelper.py --env-file /absolute/deployment/.env up
```

首次安装：`bootstrap` 启动 PostgreSQL、执行迁移，再创建初始管理员；`up` 执行迁移并启动 API、worker、web、nginx。已有实例仅执行 `up`，不会初始化数据。普通 API 重启不执行 `db push`，不修改 schema。迁移失败时不会启动新应用。管理员首次登录后配置模型、创建智能体、创建用户并分配，详见[管理员手册](admin.md)。未配置模型或未分配智能体时不能聊天，这是可见配置状态。
需要停机维护时，可执行 `down`（同义命令 `stop`）停止平台 Compose 容器和当前部署目录的用户运行容器。

## 数据、网络与资源

```text
deployment/
  .env
  data/
    postgres/                 PostgreSQL 16
    agents/<key>/             管理员维护的智能体目录
    config/opencode/          模型连接及密钥
    users/<userId>/workspace/  用户文件和输出
    users/<userId>/state/      OpenCode 原生会话与状态
    users/<userId>/managed/    已分配智能体的只读配置快照
    backups/                  可存放手工导出；整套备份工具要求目标在 data 外
```

全部业务持久化为 bind mount，没有 named volume。`DATA_ROOT_HOST` 必须是 Docker daemon 可见的绝对宿主路径；API 内 `DATA_ROOT=/data`，不能混用。`OPSHELPER_UID/GID` 同时用于 API、worker 和用户容器；`OPSHELPER_DOCKER_GID` 是 Docker socket 所属组，Linux 请核对 `stat` 结果。`postgres-init` 只修正 `data/postgres` 根目录为镜像内 PostgreSQL 身份；不能对整个 data 盲目递归 chown。

默认用户容器限额 2 CPU / 2 GiB，空闲 60 分钟回收；有执行或等待处理时不回收。默认单次执行及等待时限 30 分钟，worker 每 15 秒检查到点任务，迟到超过 2 分钟记跳过，不补跑。

`control` 内部网络连接数据库和应用；`runtime` 提供模型访问和用户容器连接，nginx 同时接入以发布宿主端口。用户容器不发布端口、不挂 Docker socket，也不挂其他用户或数据库目录。

要开放局域网，在 `.env` 将 `OPSHELPER_HTTP_HOST` 改成指定局域网 IP，再重新 `up`；必须实际访问 `/health`，Docker 显示端口映射不等于入口可达。生产公网入口应配置 HTTPS。账号、模型密钥和备份不可进入 Git、工单或普通日志。

## 更新与重启

已有 OpenCode 1 开发实例必须先按 [OpenCode 2 切换说明](opencode-2-migration.md)处理旧会话关联；不能只更新镜像标签后直接启动。V2 状态保存在每用户 `state/v2/`，与旧状态分离。后续并发修复包含 `20261013000100_schedule_manual_concurrency` 索引迁移；个人智能体功能包含 `20261014000100_personal_agent_ownership` 所有者迁移。升级由 `up` 应用，不运行 seed；迁移前先停写备份并保留原镜像。

本版本只支持新 schema 的部署，不接管旧系统数据库或 volume。升级前使用[备份恢复](backup-restore.md)停写备份，保留完整旧镜像和发布目录；完成后重新 `up`。不要将当前迁移直接用于改造前数据库，也不要使用 `prisma db push` 作为部署升级命令。

Compose 服务使用 `restart: unless-stopped`。手动停止的容器不会因为 Docker 重启自行恢复。动态用户容器由 API 按需唤醒，个人计划由 worker 独立登记。整台宿主机开机恢复还依赖 Docker 自启动、磁盘挂载和网络。

确认部署后查看：`/health`、`status`、管理员登录、真实问答、文件读写、到点任务记录。健康检查只证明进程服务，不能替代模型连接验证。
