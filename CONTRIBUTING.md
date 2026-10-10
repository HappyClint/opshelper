# 贡献指南

欢迎为 opshelper 修复问题、改进功能和完善文档。较大的功能或架构调整，建议先在 [Issues](https://github.com/HappyClint/opshelper/issues) 中说明目标和方案，再开始开发。

每个 PR 尽量只解决一个问题。本项目由维护者 [@HappyClint](https://github.com/HappyClint) 统一审核和合并。

## 贡献者与协作者的区别

| 事项 | 普通贡献者 | Collaborator（协作者） |
| --- | --- | --- |
| 修改放在哪里 | 自己的 Fork 中 | 可直接放在本仓库的新分支中，也可使用 Fork |
| 是否需要 Fork | 需要 | 不需要 |
| 能否向本仓库的开发分支推送 | 不可以 | 可以 |
| 合入 `master` 的方式 | 提交 PR，由维护者审核和合并 | 提交 PR，由维护者审核和合并 |

贡献过代码不会自动获得协作者权限；协作者需要由维护者邀请，并接受邀请。

`master` 当前采用两条保护规则，适用于所有提交到该分支的贡献：

- `master-history-protection`：禁止强制推送和删除，管理员也没有豁免。
- `master-pr-review`：贡献者和协作者必须通过 PR 提交修改，并获得代码所有者的批准。当前 [.github/CODEOWNERS](.github/CODEOWNERS) 指定 `@HappyClint` 负责所有文件，因此其他人的批准不能替代维护者的批准。

审批后再推送新的代码改动，原批准会失效，需要维护者重新审核。仓库管理员保留 `Always allow` 审核豁免，可处理自己的 PR；该豁免不影响禁止强推和删除的规则。实际生效的设置可在 [Repository rules](https://github.com/HappyClint/opshelper/rules) 查看。

GitHub 在权限上允许协作者于获批后合并 PR；本项目的协作约定是由维护者统一执行合并，请勿自行合并，除非维护者明确安排。

## 普通贡献者：通过 Fork 提交 PR

### 1. Fork 并创建修改分支

在 [项目首页](https://github.com/HappyClint/opshelper) 点击 **Fork**，将仓库复制到自己的 GitHub 账号。

以下命令以新克隆的仓库为例。将 `YOUR_GITHUB_USERNAME` 替换为自己的 GitHub 用户名；`fix/example` 是示例分支名，可按改动命名为 `fix/...`、`feat/...` 或 `docs/...`。

```bash
git clone https://github.com/YOUR_GITHUB_USERNAME/opshelper.git
cd opshelper
git remote add upstream https://github.com/HappyClint/opshelper.git
git fetch upstream master
git switch -c fix/example upstream/master
```

此时 `origin` 指向自己的 Fork，`upstream` 指向本项目。已有本地仓库时，用 `git remote -v` 核对这两个地址，并从最新的 `upstream/master` 创建分支。

### 2. 修改、验证并推送

完成修改和下文的验证后，用 `git add` 选择本次改动的文件，再提交、推送：

```bash
git commit -m "fix: describe the change"
git push -u origin fix/example
```

请将提交说明改为实际解决的问题；若使用了其他分支名，推送时使用对应名称。

### 3. 创建 PR

在 GitHub 点击 **Compare & pull request**；手动创建时选择 **compare across forks**，确认来源和目标：

| 设置 | 选择 |
| --- | --- |
| Base repository | `HappyClint/opshelper` |
| Base branch | `master` |
| Head repository / Head fork | 自己的 Fork |
| Compare branch | 本次修改的分支，例如 `fix/example` |

填写改动说明和验证结果后，点击 **Create pull request**。未完成的改动可以先创建 Draft PR，准备好后再标记为 **Ready for review**。

## Collaborators：在本仓库分支上提交 PR

接受协作者邀请后，可以直接在本仓库创建开发分支，无须 Fork。以下仍以新克隆的仓库为例：

```bash
git clone https://github.com/HappyClint/opshelper.git
cd opshelper
git fetch origin master
git switch -c fix/example origin/master
```

已有本地仓库时，先确认 `origin` 指向 `HappyClint/opshelper`，更新 `origin/master` 后创建分支。

完成修改和验证，用 `git add` 选择本次改动的文件，然后提交、推送：

```bash
git commit -m "fix: describe the change"
git push -u origin fix/example
```

在本仓库创建 PR，选择 **base: `master`**、**compare: 本次修改分支**，按下文要求填写说明。协作者权限允许你推送开发分支，但不能绕过 `master` 的 PR 和代码所有者审核要求。

## 开发与验证

本地开发使用 Node.js 22 和 npm。在仓库根目录准备依赖：

```bash
npm ci
npx prisma generate
```

提交代码修改前运行：

```bash
npm run typecheck
npm test
```

`npm test` 包含各工作区测试和 seed 测试。按改动范围补充检查：

| 改动范围 | 补充验证 |
| --- | --- |
| Web 页面或组件 | `npm run build:web`，实际检查相关页面并附截图；涉及响应式布局时检查窄屏 |
| Prisma schema 或迁移 | `npm run prisma:validate`，重新生成 Prisma client，并验证相关迁移与数据兼容性 |
| 配置、容器生命周期、文件处理或业务服务 | 补充对应的回归测试 |
| 部署、运行时镜像或备份 | 验证相关构建或部署流程，说明兼容性与回退方式 |
| 文档 | 核对命令、链接、格式和说明是否与当前实现一致 |

测试采用 `node:test` 和 `node:assert/strict`，API 测试放在被测文件旁，命名为 `*.test.ts`。TypeScript 使用严格类型检查、两空格缩进、双引号、分号及多行结构的尾逗号。其他开发约定见 [AGENTS.md](AGENTS.md)，运行环境准备见 [README.md](README.md) 和[源码部署文档](docs/guide/deployment.md)。

数据库初始化仅用于全新空数据库。升级、重启和恢复已有实例时不要运行 `bootstrap` 或 seed；本地单元测试通过也不代表真实部署已经验收。

## PR 应说明什么

提交标题采用 Conventional Commit 风格，例如 `fix(api): ...`、`feat(web): ...`、`docs: ...`。PR 说明应包含：

- 解决的问题、修改原因，以及相关 Issue；修复问题时给出复现方法。
- 主要改动与修改后的行为。
- 实际执行的验证命令和结果；未完成的验证也请说明。
- UI 改动的截图。
- Prisma 迁移、新环境变量、运行时镜像变化，以及对部署和备份兼容性的影响；没有这些变化时可简要注明。

新配置项应同步记录到 `.env.example`。不要提交 `.env`、密钥、数据库凭据、日志、业务数据、具体部署记录或镜像归档。提交前核对本次包含的文件和差异。

## 维护者如何审核和合并

1. 维护者查看 PR 的目标、说明和 **Files changed**，核对实现、权限校验、数据兼容性及部署影响，并检查验证结果；必要时本地检出 PR 复测。
2. 需要修改时，维护者提交 **Request changes** 或逐行评论。贡献者在原分支追加提交并推送，PR 会自动更新，无须另开 PR。
3. 维护者重新检查最新改动，通过后提交 **Approve**。既有批准因新增代码改动失效时，需要再次批准。
4. 由维护者执行合并，通常使用 **Squash and merge**，将整个 PR 整理为一个提交，并保留清楚的提交标题和说明。管理员自己的 PR 使用保留的审核豁免处理。
5. 合并后可以清理已合并的开发分支，并从最新 `master` 开始下一次修改。`master` 本身受禁止删除和强推的保护。

合并代码与发布、部署分别安排；PR 合并不表示运行中的实例已经升级。

## GitHub 操作参考

- [从 Fork 创建 PR](https://docs.github.com/en/pull-requests/how-tos/create-pull-requests/creating-a-pull-request-from-a-fork)
- [审核 PR](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/reviewing-proposed-changes-in-a-pull-request)
- [合并 PR](https://docs.github.com/en/pull-requests/how-tos/merge-and-close-pull-requests/merging-a-pull-request)
