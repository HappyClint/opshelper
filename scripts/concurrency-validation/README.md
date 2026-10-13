# 调度竞争回归

`races.ts` 使用真实 PostgreSQL 和项目的调度、暂停、手动执行、出队代码。通过测试内屏障固定易丢失的事务交错；不启动执行容器、不调用模型，也不修改服务实现。请另外进行多用户真实模型执行验收。

## 运行

先创建一个**专用、可丢弃**的 PostgreSQL 16 数据库，名称必须为 `opshelper_concurrency_e2e`。脚本每组用例会删除该库的用户、智能体及关联业务记录，不可连接开发或生产业务库。建议使用独立容器及独立凭据，不共享业务卷。

在仓库根目录，先将 `DATABASE_URL` 设置为该专用库的连接串，再执行：

```bash
export OPSHELPER_CONCURRENCY_TEST=1
export NODE_ENV=test
export DATA_ROOT="$PWD/.temp/concurrency-validation/data"
export DATA_ROOT_HOST="$DATA_ROOT"
export CONCURRENCY_REPORT="$PWD/.temp/concurrency-validation/races.json"
mkdir -p .temp/concurrency-validation
npx prisma generate
npx prisma migrate deploy
node --import tsx scripts/concurrency-validation/races.ts
```

脚本同时检查数据库名和显式测试标记；迁移命令本身没有此保护，运行迁移前必须确认连接目标。不要把凭据、报告或数据库卷提交到 Git。结束后只清理专用测试资源。

## 断言

1. 手动触发先通过事务外检查，暂停随后提交：触发必须返回冲突，不得创建执行。
2. 出队先读取排队记录，暂停随后取消它：领取失败，记录保持取消，用户租约为空。
3. 领取已成功后暂停：保留启动中的执行，不把暂停误作中断。
4. 两个领取者同时出队同一用户的两项任务：只允许一个启动，另一个排队。
5. 20 个相同手动请求标识：只生成一项执行。
6. 20 个独立手动请求同时提交：全部入队，每个只生成一项执行。
7. 50 轮自然到点与暂停同时提交：最终暂停、无待运行执行、无重复记录。
8. 10 个自然调度领取者争抢同一触发点：只生成一次运行和执行。

自然调度使用可串行化事务；竞争失败方允许出现 `P2034`，由后续调度扫描重试。暂停调用必须成功。脚本失败返回非零状态，并输出逐项结果到 `CONCURRENCY_REPORT`。

覆盖的是单机 PostgreSQL 事务竞争；不代表多进程故障恢复、跨主机部署、长期负载或模型提供方稳定性已验收。
