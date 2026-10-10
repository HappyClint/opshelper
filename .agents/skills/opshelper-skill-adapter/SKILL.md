---
name: opshelper-skill-adapter
description: 将下载或外部来源的单个 Skill ZIP 检查、改造并重新打包为可直接导入 opshelper 智能体的兼容 ZIP。用于处理输出目录、临时目录、配置目录、依赖和包结构不符合 opshelper `/workspace` 运行边界的问题；不用于改造整个 Agent 目录或直接修改 opshelper 运行时镜像。
---

# opshelper 技能适配

<!-- opshelper-workspace-policy:v1 -->

把用户指定的一个 Skill ZIP 改造成 opshelper 可导入、运行时只在 `/workspace` 读写的 ZIP。保留技能原意、许可证、资源和脚本；不要把“能够导入”误报成“已完成真实业务验证”。

## 已核实的 opshelper 边界

- 导入包必须包含且只能包含一个 `SKILL.md`。允许有一层或多层外包装目录，但所有有效文件必须位于该 `SKILL.md` 所在目录内。
- `SKILL.md` 必须是 UTF-8 文本，frontmatter 中的 `name` 必须是最长 64 字符的小写 kebab-case，`description` 必须非空且不超过 1024 字符。
- 包最多 512 个文件，解压后总计不超过 32 MiB，单文件不超过 16 MiB；禁止路径穿越、绝对路径、符号链接以及 `.git`、`.opencode`、`node_modules`、`__MACOSX`。
- 导入后 opshelper 会把技能放入受管只读配置，并在运行时给技能名添加 Agent key 前缀。不能写死原 ZIP 目录名或安装后的绝对技能目录。
- OpenCode 的 skill 工具会给出当前技能的 base directory。读取随包资源时使用这个实际 base directory；用户文件、生成物、临时文件、缓存、状态和需要修改的资源副本一律放在 `/workspace`。
- `/workspace` 中的 `opencode.json`、`.opencode/` 等项目配置不会成为 opshelper 的受管配置来源。技能不得尝试修改运行时配置、安装依赖或写入 home/XDG 目录。
- 当前运行镜像可直接依赖 `python3`、Node.js、git、ripgrep，以及镜像已预装的 Python 包。不得在任务中执行 `pip install`、`npm install`、`apt` 等联网或系统级安装；缺少依赖时明确报告，不伪造兼容结果。

## 执行流程

1. 让用户明确指出 `/workspace` 中的源 ZIP；只有存在多个候选且无法判断时才提问。不要扫描 `/workspace` 之外的位置。
2. 从 skill 工具返回内容中取得本技能的 base directory，以绝对路径调用 `scripts/adapt_skill.py`。该脚本只读技能目录，全部工作文件写入 `/workspace`。
3. 首先运行自动适配：

   ```bash
   python3 "<本技能 base directory>/scripts/adapt_skill.py" adapt \
     /workspace/<源技能>.zip \
     /workspace/<源技能>-opshelper.zip
   ```

   脚本会安全解包、移除系统垃圾文件、改写已知的外部输出/临时/配置根、在 `SKILL.md` 注入 opshelper 运行约束、审计依赖与残余路径，并在通过后生成 ZIP。它不会覆盖既有输出。
4. 若命令返回“存在阻断项”，读取命令给出的 `ADAPTATION_REPORT.md` 和工作目录。逐项做语义化修正，不要用全局替换猜测：
   - 输入文件路径改为用户明确提供的 `/workspace/...`。
   - 默认输出改为 `/workspace/outputs/<有意义的任务目录>/`；用户指定输出路径时优先服从，但仍必须位于 `/workspace`。
   - 临时文件改到 `/workspace/.tmp/<技能名>/`；持久配置、缓存和状态分别改到 `/workspace/.opshelper/<技能名>/config|cache|state/`。
   - 随包脚本、模板和参考资料从 skill 工具给出的实际 base directory 读取。若第三方库要求修改模板，先复制到 `/workspace/.tmp/<技能名>/`。
   - 删除运行时安装步骤。依赖已在镜像中才可保留；缺少外部二进制或 Python/Node 包时，将其改造成现有能力可执行的实现，否则停止并报告“需要更新运行镜像”，不要仍然打包为已兼容。
   - 不创建或修改 `.opencode`、`opencode.json`、home、XDG、系统目录，也不依赖固定 Agent key 或固定技能安装路径。
5. 修正工作副本后重新审计，再打包：

   ```bash
   python3 "<本技能 base directory>/scripts/adapt_skill.py" audit \
     /workspace/.opshelper-skill-adapter/<任务>/skill

   python3 "<本技能 base directory>/scripts/adapt_skill.py" pack \
     /workspace/.opshelper-skill-adapter/<任务>/skill \
     /workspace/<源技能>-opshelper.zip
   ```

6. 对最终 ZIP 再执行一次 `inspect`。向用户给出 ZIP 的绝对路径、技能名、改造摘要、仍需由目标 Agent/镜像提供的依赖，以及验证边界。

## 验收标准

- `inspect` 返回通过，ZIP 能满足 opshelper 当前导入器的结构、frontmatter、数量、大小和安全路径约束。
- 所有可变数据只写 `/workspace`；技能包自身只读。没有 home/XDG、宿主机、`/tmp`、其他平台共享目录或项目级 OpenCode 配置依赖。
- 资源路径不依赖未加前缀的技能目录名；命令不会要求包内脚本具备可执行位，优先使用 `python3 <脚本绝对路径>` 等解释器调用。
- 不包含凭据、`.env`、下载缓存、构建产物或与技能无关的文件。
- ZIP 生成成功只证明结构和静态兼容性。若改造涉及文档渲染、浏览器、网络、MCP 或特定第三方程序，必须把尚未执行的真实验证明确列出。
