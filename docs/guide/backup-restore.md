# 整套备份与恢复

采用停写备份：PostgreSQL 逻辑转储与同一停写窗口内的用户文件、原生会话、智能体和模型配置一起保存。数据库记录不能代替 OpenCode `state`，只复制 workspace 也不能恢复会话。

## 备份

先让用户完成或取消执行，处理等待输入、状态待核对和配置变更。备份工具会停止当前部署的 nginx/web/worker/API，再核对数据库；仍有活动/排队/待恢复状态时拒绝备份并保持应用停止，需 `up` 处理后重试。工具只停止 bind 来自当前 `DATA_ROOT_HOST/users/` 的用户容器，不操作其他部署。

```bash
python3 scripts/opshelper.py --env-file /absolute/source/.env backup --output /absolute/backups/opshelper-20260914
```

目标目录必须不存在，且不能位于源 data 内或包含源 data。备份包含：

- `database.dump`：数据库逻辑转储，含账号、密码 hash、会话归属、执行、计划与分配；
- `data.tar`：agents、config、users，含原生会话、文件和受管快照；
- `deployment.env`：原部署参数及初始化凭据；
- `manifest.json`：版本、UID/GID、镜像 ID、时间和各文件 SHA-256。

成功后应用和用户容器保持停止，PostgreSQL 保持运行；恢复源服务用 `up`。清单不存在或 hash 不符的目录不能恢复，失败残留目录不要当作成功备份。备份目录权限 700、文件 600，含明文模型密钥和用户文件，应放在受控存储上；镜像、发布代码和本工具版本需另行保留。SHA-256 用于检查损坏，不替代可信来源校验。

## 恢复到独立目录

保持源系统停止，防止两边同时执行计划或写入同一运维对象。准备与备份时完全相同的应用、runtime、PostgreSQL 和 nginx 镜像；工具按镜像 ID 检查，跨 CPU 架构或跨 UID/GID 迁移不在当前自动恢复范围。

```bash
python3 scripts/opshelper.py --env-file /absolute/restored/.env init --project opshelper-restored --port 8081
python3 scripts/opshelper.py --env-file /absolute/restored/.env restore --backup /absolute/backups/opshelper-20260914
python3 scripts/opshelper.py --env-file /absolute/restored/.env up
```

如果在同一个 Docker daemon 恢复，同一用户 ID 对应的容器名会冲突。先确认源平台及这些用户容器都已停止，再对清单中的源用户容器执行 `docker rm <明确的容器名>`，只删除容器对象，保留所有 bind 数据；不要带 `-v`，不要批量删除其他部署。源应用保持停止。不同 Docker daemon 没有容器名冲突，但仍应避免双边同时执行计划。

恢复拒绝已有目标容器、非空业务目录、非空数据库、越界归档和不安全链接。恢复失败时留下目标现场用于排查，不覆盖重试；换新的空目录重新开始。工具保留业务状态，只清除指向旧 Docker 的容器 ID、已结束的执行槽位和生命周期锁，下一次访问按新路径创建容器。恢复后只运行 `up`，不要运行 `bootstrap` 或 seed。新 `.env` 的随机管理员密码不会覆盖数据库中原密码；必须使用备份前账号密码登录。

## 验收与回退

核对账号与分配、文件 hash、Conversation/Execution/Schedule/ScheduleRun 数量、历史正文和原生协作，执行一次新问答。计划的停机漏点仍按 2 分钟规则跳过，不保证补回停机期间工作。

若恢复实例失败：停止该实例的应用和用户容器，保留现场；恢复源部署的原镜像与 `.env` 后执行 `up`。同一 daemon 回退前同样需移除已停止的恢复实例用户容器对象。不能把新运行后产生的数据库简单复制回旧实例。回退应使用升级前的备份及对应版本的镜像、源码与配置。
