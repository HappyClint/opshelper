# opshelper x86_64 离线部署

本文用于 **Linux x86_64（linux/amd64）物理机的全新部署**。请使用与当前版本对应的离线发布包，并核对包内源码和镜像清单。无需源代码、Node.js、Python、npm、pip 或部署脚本。不要直接用于接管旧数据库。

## 1. 包内容与前提

- `images.tar.gz`：API、Web、Worker、OpenCode 1.18.34 运行环境、PostgreSQL 16、nginx，共 6 个镜像。
- `docker-compose.yml`：移除构建段，固定 `linux/amd64`，各服务设置 `pull_policy: never`。
- `.env.example`、`deploy/nginx/default.conf`：部署参数模板与代理配置。
- `images-manifest.json`、`source-manifest.json`、`SHA256SUMS`：镜像身份、构建源文件哈希与文件完整性校验。
- `DEPLOYMENT.md`：本文；`VALIDATION.md`：打包端验证结果。

目标机需预先安装并启动 Docker Engine 和 **Docker Compose v2**，提供 `docker-compose` 命令；若仅提供 `docker compose`，将下文所有 `docker-compose` 替换为 `docker compose`。不支持旧版 Python Compose v1。Docker 及 Compose 的离线安装包取决于目标 Linux 发行版，本包不包含这两项宿主软件。

下文在目标机使用 Bash、以 root 执行，假定部署路径为 `/opt/opshelper`。需要 `tar`、`sha256sum`、`openssl`、`curl` 等系统命令。先检查：

```bash
uname -m
# 应为 x86_64
docker version
docker-compose version
systemctl enable --now docker
```

容量按实际用户数规划：每个活动用户的 OpenCode 容器默认最多使用 2 CPU、2 GiB 内存，另需为数据库、平台服务和文件留出资源。离线包不包含模型权重、现有业务数据、模型密钥或自定义智能体。模型 API 必须在内网可达；新增技能/MCP 的额外依赖也需另行离线准备。运行环境已预装项目 requirements.txt 中的 Python 依赖。

## 2. 解压、校验、加载镜像

将完整发布压缩包及其 `.sha256` 文件复制到物理机，在文件所在目录执行：

```bash
OPSHELPER_BUNDLE="/absolute/path/opshelper-offline-linux-amd64-RELEASE.tar.gz"
sha256sum -c "$OPSHELPER_BUNDLE.sha256"
# /opt/opshelper 应为本次全新部署的空目录
mkdir -p /opt/opshelper
tar -xzf "$OPSHELPER_BUNDLE" -C /opt/opshelper
cd /opt/opshelper
sha256sum -c SHA256SUMS

docker load -i images.tar.gz

# 从已验证的包内 .env.example 读取镜像标签，并核对架构
images=$(sed -nE 's/^(OPSHELPER_(API|WEB|WORKER|POSTGRES|NGINX)_IMAGE|OPENCODE_DOCKER_IMAGE)=(.+)$/\3/p' .env.example)
for image in $images; do
  docker image inspect --format '{{.RepoTags}} {{.Os}}/{{.Architecture}}' "$image"
done
```

应全部显示 `linux/amd64`。保留镜像标签与模板一致；不要执行 `docker pull` 或 `docker-compose build`。

## 3. 配置密码、身份和持久化目录

```bash
cd /opt/opshelper
umask 077
cp .env.example .env
chmod 600 .env
openssl rand -hex 24
openssl rand -hex 18
stat -c '%g' /var/run/docker.sock
```

编辑 `.env`，分别将上述两次随机字符串作为数据库密码和管理员密码，并填写 Docker socket 实际组 ID：

```dotenv
POSTGRES_PASSWORD=填写第一次随机字符串
OPSHELPER_ADMIN_PASSWORD=填写第二次随机字符串
DATA_ROOT_HOST=/opt/opshelper/data
OPSHELPER_UID=1000
OPSHELPER_GID=1000
OPSHELPER_DOCKER_GID=填写stat输出的组ID
OPSHELPER_HTTP_HOST=0.0.0.0
OPSHELPER_HTTP_PORT=8080
COMPOSE_PROJECT_NAME=opshelper-offline
```

数据库密码仅使用 `A-Z a-z 0-9 _ -`，避免破坏数据库连接 URL；管理员密码至少 12 位。UID/GID 1000 是本例容器运行身份，也可选择其他非 root UID/GID，但必须同步调整下方目录所有者。保留模板内全部镜像变量。

`DATA_ROOT_HOST` 是物理机绝对路径，不能填容器内的 `/data`。`0.0.0.0:8080` 用于内网访问，可改为指定内网 IP；按现场防火墙策略开放对应端口。此配置为 HTTP 内网入口。

```bash
mkdir -p /opt/opshelper/data/postgres \
  /opt/opshelper/data/agents \
  /opt/opshelper/data/config/opencode \
  /opt/opshelper/data/users \
  /opt/opshelper/data/backups
chown 1000:1000 /opt/opshelper/data /opt/opshelper/data/agents \
  /opt/opshelper/data/config /opt/opshelper/data/config/opencode \
  /opt/opshelper/data/users /opt/opshelper/data/backups
chmod 750 /opt/opshelper/data /opt/opshelper/data/agents \
  /opt/opshelper/data/config /opt/opshelper/data/config/opencode /opt/opshelper/data/users
chmod 700 /opt/opshelper/data/backups
```

PostgreSQL 数据目录由 Compose 的 `postgres-init` 自动设为 `999:999`、权限 `700`。不要递归修改已运行数据库的所有者。SELinux enforcing 主机还需按现场策略允许容器访问这些 bind mount 和 Docker socket；本包不自动更改系统安全策略。

## 4. 使用 Compose 部署

```bash
cd /opt/opshelper
# 仅验证配置，避免将含密码的展开配置输出到终端/日志
docker-compose --env-file .env config --quiet

# 首次安装：启动数据库、迁移，再显式初始化空数据库
docker-compose --env-file .env up -d --no-build --pull never --wait postgres
docker-compose --env-file .env run --rm --no-deps --pull never migrate
docker-compose --env-file .env run --rm --no-deps --pull never bootstrap

# 全部镜像只取本地，不构建、不联网拉取
docker-compose --env-file .env up -d --no-build --pull never

docker-compose --env-file .env ps -a
docker-compose --env-file .env logs --tail=100 migrate
```

启动依赖顺序：`postgres-init` → PostgreSQL 健康 → `migrate` 仅执行 `prisma migrate deploy`，首次安装再显式运行 `bootstrap` → API → Worker、Web → nginx。迁移已内置镜像，使用本地 npm 命令执行，不下载依赖。`bootstrap` 只允许所有业务表为空；升级、重启和恢复禁止运行它或 seed。旧发布包可能仍将 seed 与迁移绑定，操作时必须遵循对应包的版本说明，不要套用当前命令。

预期 `postgres-init`、`migrate` 为 `Exited (0)`；postgres、api、worker、web、nginx 为运行且健康。迁移失败时先查看日志解决，不执行 `prisma db push`。

## 5. 验收

```bash
curl -f http://127.0.0.1:8080/health
curl -I http://127.0.0.1:8080/
# 如更改了绑定地址/端口，相应替换上面的地址
```

从另一台内网电脑打开 `http://物理机IP:8080/`，以 `admin` 和 `.env` 中 `OPSHELPER_ADMIN_PASSWORD` 登录。仅空数据库首次初始化设置密码；重复启动不会重置已有管理员。

在管理界面配置内网模型连接（URL 必须从用户容器可达，不能把宿主机模型地址写成容器自己的 `127.0.0.1`），创建智能体、用户并分配智能体。普通用户也可在工作台“智能体目录”创建智能体，保存后会自动分配给自己。完成真实问答、上传/读取/生成文件、到点定时任务测试，再确认无外网情况下仍可运行。没有模型或智能体时无法聊天不代表镜像加载失败。

健康检查只证明平台进程就绪，不能替代内网模型、用户容器和业务功能验收。包内 `VALIDATION.md` 区分打包端已验证内容与现场待验收内容。

## 6. 查看日志、停止与重新启动

```bash
cd /opt/opshelper
docker-compose --env-file .env logs --tail=200 api worker web nginx
docker-compose --env-file .env stop
docker-compose --env-file .env up -d --no-build --pull never
```

Compose 管理平台服务；动态用户容器由 API 创建，不在 Compose 服务列表内。维护停机前先在管理界面停止任务及用户容器。不要删除 `data/`；它包含数据库、模型配置、智能体、用户文件和会话状态。备份时同时保留 `.env` 和完整 `data/`，并在停止业务写入和数据库后备份。
