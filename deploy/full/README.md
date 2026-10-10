# x86 离线发布约定

部署步骤见 [x86 离线部署文档](../../docs/guide/offline-amd64.md)。目标机使用 `docker load` 和 Docker Compose；首次安装先执行迁移和显式空库 bootstrap，再启动平台，升级与恢复不执行 seed。具体命令以对应版本的包内文档为准。

发布归档保存在本机忽略目录 `releases/`，不提交到 Git。归档与校验文件须一起保留，不复制生产数据或凭据。

后续打包须显式构建和导出 `linux/amd64`，使用独立发布标签，保留源文件及镜像清单，实际验证 `docker load`、迁移和服务健康。根 `docker-compose.yml` 是部署定义源；发布副本删除 build 段、固定架构并禁止拉取镜像。

