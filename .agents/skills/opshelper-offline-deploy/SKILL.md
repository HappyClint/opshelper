---
name: opshelper-offline-deploy
description: 为 opshelper 制作 Linux x86_64 离线镜像压缩包和 Markdown 部署文档，指导全新安装，并基于上次 release 生成仅含改动镜像、升级说明及必要非镜像变更的最小连续升级包。用于 opshelper 离线交付和版本部署，不用于一般代码开发或其他项目的通用部署。
---

# opshelper 离线部署与升级

将用户指定的 opshelper 版本交付为可验证的 `linux/amd64` 离线发布包，目标机直接执行 `docker load`、`docker-compose` 命令。默认交付 Markdown 文档，不生成或要求执行部署脚本。全新安装交付完整镜像集合和初始化配置；升级采用最小交付，只提供相对基线有改动的镜像、`UPGRADE.md` 和校验文件。数据库迁移、Compose/nginx 变更或其他非镜像文件只有在本次确实发生变化且现场升级需要时才加入，不重复携带初始化安装材料。

本技能属于当前 opshelper 项目。以包含本技能的仓库根目录为项目根，不使用全局技能副本，也不把其他 checkout 的发布物当作本项目基线。

## 选择工作范围

- 制作/重打镜像包：读 [packaging.md](references/packaging.md)；若项目已有 release，先读 [release-lineage.md](references/release-lineage.md) 确定连续交付基线。
- 全新物理机安装：读 [fresh-install.md](references/fresh-install.md)。
- 已有实例升级、恢复或回退：先读 [release-lineage.md](references/release-lineage.md)，再读 [upgrade.md](references/upgrade.md)。必须基于上次已交付 release 与本次版本给出具体升级链，不可只交付通用升级说明或套用空库安装流程。
- 一项任务覆盖多个场景时读取对应参考；仅编写指导文档不隐含实际停机或部署授权。已有明确部署授权无需重复确认。

## 先核实当前版本

从本技能所在项目定位仓库，核实用户指定路径与当前工作区。读取实际 `AGENTS.md`、根 `docker-compose.yml`、`.env.example`、`Dockerfile`、`deploy/opencode-runtime/Dockerfile` 及其 `requirements.txt`、相关 Prisma 迁移和 `docs/guide/` 文档。升级另读 seed、容器生命周期和现有备份恢复实现。

使用当前文件与 Docker 实际状态作判断，不能把 2026-09-17 的镜像标签、数据库版本、服务数、端口或本机生产路径当永久默认值。源文件缺失时先获得本次版本的配置/源码/清单，不根据旧笔记编造可执行升级命令。不要打印 `.env`、模型密钥或展开后的含密配置。

当前架构作为检查起点：API、Web、Worker、OpenCode runtime、PostgreSQL、nginx 共六类镜像；`postgres-init`、`migrate` 复用镜像。动态用户容器由 API 创建，不在 Compose 服务列表中。技能示例位于 `examples/opencode-config/`，不自动进入部署；运行数据在宿主 data 的 agents、config、users、postgres 等目录中。

## 贯穿所有场景的约束

- x86 物理机对应 `linux/amd64`。ARM 构建机可交叉构建，但要验证镜像归档内实际架构，不以标签名为证据。
- `DATA_ROOT_HOST` 必须是 Docker daemon 可见的宿主绝对路径；API 的 `/data` 只是容器内路径。保留 UID/GID 与 Docker socket 组权限关系。
- 有改动的镜像使用新的唯一固定标签；未变镜像沿用基线标签和身份，不为凑齐新版本标签而重新打包。全新安装的发布 Compose 从根定义派生：无 build 段、固定架构、`pull_policy: never`；包含动态 runtime 的镜像变量及初始化服务。升级默认继续使用现场已有配置，除非本次配置本身发生变化。
- 镜像包不包含生产数据、凭据、模型权重或未经配置的自定义智能体。离线环境仍需可达的内网模型，MCP/额外技能依赖也须明确准备。
- 镜像加载、文件准备与校验可在授权范围内完成；实际停机、迁移和恢复依据用户的部署授权。执行前将目标实例、版本、路径及回退方式具体化；缺少关键升级信息时继续做独立的打包/分析工作，暂停依赖该信息的变更。
- 已交付归档保持不变；源码清理或后续改动不能伪称已进入旧包。新包使用新版本标识。
- 不全局 prune，不删除其他项目容器，不自动重写 Git 历史。镜像、发布包、源码提交和数据备份是不同对象，不能互相替代。

## 交付与事实表达

发布物保存到仓库忽略的 `releases/<release-id>/`；构建临时文件在 `.temp/<task>/`，受控备份位于 data 之外。最终回复提供包、校验文件和文档链接，并说明源代码版本、镜像架构、已验证项与现场待验项。

记录源码提交及工作区是否包含未提交改动、镜像/配置清单、校验值、构建与迁移验证结果。升级时把这些必要的血缘、差异、镜像身份、迁移、备份、验收和回退信息集中写入针对明确 `from → to` 的 `UPGRADE.md`，不为内部记录额外扩张交付文件集合。区分“打包端 amd64 模拟验证”“目标 x86 物理机验证”“真实模型业务验证”。不得用健康接口成功代替业务验收；全新安装通过不证明任意后续版本都可直接升级。
