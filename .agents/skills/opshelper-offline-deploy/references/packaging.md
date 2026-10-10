# 制作离线发布包

## 固定输入与版本

项目已有 release 时，先按 [release-lineage.md](release-lineage.md) 检查上次发布文件夹，固定本次升级来源。升级包只包含相对基线有改动的镜像，并附带明确版本之间的差异和操作步骤；全新安装才提供完整镜像集合。

核实 Git 状态、构建源、磁盘空间、Docker daemon 与 Buildx 支持的平台。用户未要求只打已提交版本时，可包含当前工作区修改，但必须记录并制作一致的源码快照；不要隐式丢弃未提交修改。上下文只含构建必要文件，排除生产目录、凭据、备份、历史归档、node_modules、.next。

为本次发布选择未使用的 release ID 和独立镜像标签，避免覆盖本机正在使用的 `local` 等标签。构建过程可联网，部署过程必须不依赖在线拉取或 npm/pip 安装。Next.js 构建可能联网获取字体；构建机的依赖下载失败不等于目标离线运行失败。

## 构建与依赖

按当前 Dockerfile 的 api、worker、web target 构建；runtime 使用自己的 Dockerfile。命令模式如下，生成交付文档时替换成实际标签与路径：

```bash
docker buildx build --platform linux/amd64 --load --target api -t <api-tag> <source-snapshot>
docker buildx build --platform linux/amd64 --load --target worker -t <worker-tag> <source-snapshot>
docker buildx build --platform linux/amd64 --load --target web -t <web-tag> <source-snapshot>
docker buildx build --platform linux/amd64 --load -t <runtime-tag> <runtime-source>
docker pull --platform linux/amd64 <postgres-version>
docker pull --platform linux/amd64 <nginx-version>
```

基础镜像也以本次发布标签固定并记录摘要。多架构 image index 在本机 `inspect` 可能默认显示 ARM；用支持 `--platform linux/amd64` 的检查和导出，并最终解析归档 config 的 `os`/`architecture`。不要为了单架构标签盲目按 config hash 执行 `docker tag`，它不一定是 Docker 可寻址的镜像 ID。

runtime 校验其固定 OpenCode 版本、内置 provider 支持及 Python 依赖；新增 SDK、MCP、浏览器或系统工具依赖需实际纳入镜像或列为明确的独立交付项。不要把历史技能目录存在等同于已装入用户运行环境。

## 选择交付内容并压缩

全新安装时，从当前根 Compose 派生一次发布副本，保留服务依赖、网络、卷、健康检查与环境变量逻辑；移除 build，添加固定平台与 `pull_policy: never`，并填写完整镜像集合。创建不含凭据的参数模板和相对路径正确的 nginx 配置，使用虚构安全值做 `config --quiet` 校验，不输出实际密码。不要人工维护长期分叉的第二套 Compose。

升级默认沿用现场已有 Compose、`.env` 和 nginx 配置，不把全新安装用的 `docker-compose.yml`、`.env.example`、nginx 配置或 `DEPLOYMENT.md` 重复放进升级包。只有这些非镜像内容相对基线确有变化、且现场必须应用时，才加入对应完整文件或清晰补丁，并在 `UPGRADE.md` 写明合并方法、保留项和回退方法。数据库迁移 SQL、数据修复文件或其他升级资产同理按实际变化加入。

```bash
set -o pipefail
docker image save --platform linux/amd64 <included-image-tags> | gzip -1 > images.tar.gz
```

升级时 included-image-tags 仅列清单中确认为有改动的镜像；全新部署时列完整集合。这里的“增量”指整镜像集合的增量，不制作依赖现场 Docker layer cache 的差分层归档。有改动的镜像仍须完整 docker save。

检测本机 Docker 是否支持 `save --platform`。如不支持，使用经验证的单架构导出方式；不能静默省略平台选择。只加载目标平台再打包，不将多平台缓存全部带入归档。

全新安装包继续包含完整镜像、发布 Compose、`.env.example`、nginx 配置、部署与验证文档、必要清单和 `SHA256SUMS`。

升级包采用最小文件集合：

- 有镜像变化时包含 `images.tar.gz`；无镜像变化时不制造空归档。
- 必须包含针对明确 `from → to` 的 `UPGRADE.md`，其中集中记录基线归档校验值、允许来源、源码状态、包含和复用的镜像身份、逐项差异、迁移/配置影响、备份、执行、验收及回退步骤。
- 必须包含覆盖包内文件的 `SHA256SUMS`，最终外层归档另附 `.sha256`。
- 仅在数据库迁移、Compose/nginx、环境变量或其他非镜像资产确有变化时，加入对应文件或补丁。
- 默认不加入 `DEPLOYMENT.md`、`VALIDATION.md`、`README.md`、`release-manifest.json`、`RELEASE-DIFF.md`、源码/镜像清单及任何未变化的初始化配置；除非用户明确要求或本次变更使其成为现场升级所必需。

再压缩为 `opshelper-offline-linux-amd64-<release-id>.tar.gz` 并附外部 `.sha256` 文件。用实际文件生成校验值，检查最终归档内部文件集合及哈希。宿主 Docker/Compose 离线安装包需要目标发行版、版本和现有安装状态；未知时明确列为前提，不猜一个通用安装包。

## 验证与收尾

1. 类型检查、API/相关 seed 测试及 Web production build；根据本次变更补充相关验证。
2. 实际 `docker load -i images.tar.gz`，逐项确认归档镜像标签与架构，核对现有 Compose 和 runtime 的每个引用都能由“本次包内镜像”或 `UPGRADE.md` 声明的基线镜像满足。
3. 全新包用独立项目名、数据根目录和端口执行禁止拉取的全新启动；升级包先建立准确基线，再只加载本次有改动的镜像，核对迁移/初始化退出 0、服务健康、入口及管理员登录。
4. runtime 在 `--network none` 下验证 CLI、服务健康和必要 Python imports。模型业务验证需另有可达模型，明确其边界。
5. 若承诺支持某旧版本升级，按 upgrade.md 在隔离副本上完成迁移和恢复演练；全新初始化成功不替代升级测试。
6. 只清理本次创建的测试容器及其空网络，先依据实际挂载区分动态用户容器。保存证据后清理复制源和临时数据，保留最终归档。

不得使用本机生产 `.env`、生产绑定目录或真实生产管理员密码进行打包端验收。若升级演练需要数据副本，使用被授权的受控备份，并隔离外部执行以防定时任务/工具触碰真实系统。
