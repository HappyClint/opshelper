/**
 * 智能体目录的纯函数：把 `data/agents/<key>/` 里的文件清单整理成前端文件树，
 * 并解析 agent.md frontmatter 里对 Skill 和脚本的引用。
 *
 * 这里只做展示用的宽松解析：真正的校验在 API 侧完成，页面不能因为文档写坏就崩。
 */

/** 目录树节点：有子节点的是目录，叶子节点是文件。 */
export interface AgentTreeNode {
  /** 显示名，即路径的最后一段。 */
  name: string;
  /** 完整路径：目录节点是目录本身，文件节点是文件本身。 */
  path: string;
  /** 文件节点的完整路径；目录节点为 null。 */
  file: string | null;
  children: AgentTreeNode[];
}

export interface AgentSkillGroup {
  /** 目录名，同时是 agent.md 里的技能引用名。 */
  name: string;
  /** 该技能目录下的文件总数（含子目录）。 */
  fileCount: number;
  /** 技能目录内的文件树，路径相对 skills/<名称>/。 */
  nodes: AgentTreeNode[];
  /** agent.md 是否已引用该技能；未引用的技能不会进入运行时装配。 */
  referenced: boolean;
}

export interface AgentFileTree {
  /** 智能体定义、MCP 配置等目录根文件。 */
  rootFiles: string[];
  skills: AgentSkillGroup[];
  /** scripts/ 下的文件树，路径相对 scripts/。 */
  scripts: AgentTreeNode[];
  /** scripts/ 下的文件总数，含子目录。 */
  scriptCount: number;
  /** 既不在 skills/ 也不在 scripts/ 的附属文件，正常情况下为空。 */
  others: string[];
}

const ROOT_FILE_ORDER = ["agent.md", "mcp.json"];

function frontmatterBlock(document: string): string {
  const matched = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(document);
  return matched ? matched[1] : "";
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && (trimmed.startsWith('"') || trimmed.startsWith("'"))) {
    const quote = trimmed[0];
    if (trimmed.endsWith(quote)) return trimmed.slice(1, -1);
  }
  return trimmed;
}

function inlineList(value: string): string[] | null {
  const matched = /^\[([\s\S]*)\]$/.exec(value);
  if (!matched) return null;
  const body = matched[1].trim();
  if (!body) return [];
  try {
    const parsed: unknown = JSON.parse(`[${body}]`);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) return parsed;
  } catch {
    // 退回到逗号分隔，兼容 `skills: [a, b]` 这类非严格 JSON 写法。
  }
  return body
    .split(",")
    .map((item) => unquote(item))
    .filter(Boolean);
}

/** 读取 agent.md 中 `skills:` 与 `scripts:` 两个列表，支持 YAML 列表和内联数组。 */
export function parseAgentReferences(document: string): { skills: string[]; scripts: string[] } {
  const result = { skills: [] as string[], scripts: [] as string[] };
  const block = frontmatterBlock(document);
  if (!block) return result;

  let section: "skills" | "scripts" | null = null;
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    if (section && indent > 0) {
      if (!line.startsWith("- ")) continue;
      const value = unquote(line.slice(2));
      if (value) result[section].push(value);
      continue;
    }
    const matched = /^(skills|scripts):\s*([\s\S]*)$/.exec(line);
    if (!matched) {
      section = null;
      continue;
    }
    const key = matched[1] as "skills" | "scripts";
    const rest = matched[2].trim();
    section = null;
    if (!rest) {
      section = key;
      continue;
    }
    const values = inlineList(rest);
    if (values) result[key].push(...values.filter(Boolean));
  }

  return { skills: [...new Set(result.skills)], scripts: [...new Set(result.scripts)] };
}

/**
 * 从 agent.md frontmatter 中移除一个 Skill 引用，同时尽量保留原有排版。
 * 支持块列表和内联数组；frontmatter 不完整时保持原文不变。
 */
export function removeAgentSkillReference(document: string, skillName: string): string {
  const matched = /^(\uFEFF?---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$)[\s\S]*)$/.exec(document);
  if (!matched) return document;

  const lines = matched[2].split(/\r?\n/);
  let changed = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const section = /^(\s*)skills:\s*([\s\S]*)$/.exec(line);
    if (!section || section[1].length > 0) continue;

    const rest = section[2].trim();
    if (rest) {
      const values = inlineList(rest);
      if (!values || !values.includes(skillName)) continue;
      lines[index] = `skills: ${JSON.stringify(values.filter((value) => value !== skillName))}`;
      changed = true;
      continue;
    }

    for (let itemIndex = index + 1; itemIndex < lines.length; itemIndex += 1) {
      const itemLine = lines[itemIndex];
      const trimmed = itemLine.trim();
      const indent = itemLine.length - itemLine.trimStart().length;
      if (trimmed && !trimmed.startsWith("#") && indent === 0) break;
      if (indent === 0 || !trimmed.startsWith("- ")) continue;
      if (unquote(trimmed.slice(2)) !== skillName) continue;
      lines.splice(itemIndex, 1);
      itemIndex -= 1;
      changed = true;
    }
  }

  if (!changed) return document;
  const newline = document.includes("\r\n") ? "\r\n" : "\n";
  return `${matched[1]}${lines.join(newline)}${matched[3]}`;
}

function compareRootFiles(left: string, right: string) {
  const leftIndex = ROOT_FILE_ORDER.indexOf(left);
  const rightIndex = ROOT_FILE_ORDER.indexOf(right);
  if (leftIndex !== -1 || rightIndex !== -1) {
    return (leftIndex === -1 ? ROOT_FILE_ORDER.length : leftIndex) -
      (rightIndex === -1 ? ROOT_FILE_ORDER.length : rightIndex);
  }
  return left.localeCompare(right);
}

function sortAgentTree(nodes: AgentTreeNode[]) {
  // 目录排在文件前面，同级再按名称排序，和常见文件管理器一致。
  nodes.sort((left, right) => {
    const leftFolder = left.children.length > 0;
    const rightFolder = right.children.length > 0;
    if (leftFolder !== rightFolder) return leftFolder ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
  for (const node of nodes) sortAgentTree(node.children);
}

/**
 * 把扁平文件路径整理成嵌套目录树。`depth` 是相对于路径前缀已经消费掉的段数，
 * 例如技能目录传 2，表示去掉 `skills/<名称>/` 后再建树。
 */
export function buildAgentPathTree(paths: readonly string[], depth = 0): AgentTreeNode[] {
  const root: AgentTreeNode = { name: "", path: "", file: null, children: [] };
  for (const path of [...new Set(paths)]) {
    const parts = path.split("/");
    let node = root;
    for (let index = depth; index < parts.length; index += 1) {
      const name = parts[index];
      const last = index === parts.length - 1;
      let child = node.children.find((item) => item.name === name);
      if (!child) {
        child = {
          name,
          path: parts.slice(0, index + 1).join("/"),
          file: last ? path : null,
          children: [],
        };
        node.children.push(child);
      }
      node = child;
    }
  }
  sortAgentTree(root.children);
  return root.children;
}

/** 把扁平的文件路径清单整理成“根文件 / 技能目录 / 脚本目录”三段结构。 */
export function buildAgentFileTree(
  names: readonly string[],
  referencedSkills: readonly string[] = [],
): AgentFileTree {
  const rootFiles: string[] = [];
  const scriptFiles: string[] = [];
  const others: string[] = [];
  const skillFiles = new Map<string, string[]>();

  for (const name of [...new Set(names)]) {
    const parts = name.split("/");
    if (parts.length === 1) {
      rootFiles.push(name);
      continue;
    }
    if (parts[0] === "skills" && parts.length >= 3 && parts[1]) {
      skillFiles.set(parts[1], [...(skillFiles.get(parts[1]) ?? []), name]);
      continue;
    }
    if (parts[0] === "scripts" && parts.length >= 2 && parts[1]) {
      scriptFiles.push(name);
      continue;
    }
    others.push(name);
  }

  const referenced = new Set(referencedSkills);
  const skills = [...skillFiles.entries()]
    .map(([name, files]) => ({
      name,
      fileCount: files.length,
      nodes: buildAgentPathTree(files, 2),
      referenced: referenced.has(name),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    rootFiles: rootFiles.sort(compareRootFiles),
    skills,
    scripts: buildAgentPathTree(scriptFiles, 1),
    scriptCount: scriptFiles.length,
    others: others.sort(),
  };
}

/** 文件大小展示：文本按 UTF-8 字节数，二进制按 Base64 长度反推。 */
export function formatAgentFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

export function textByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function base64ByteLength(base64: string): number {
  return Math.ceil((base64.length * 3) / 4);
}

export function countLines(text: string): number {
  if (!text) return 0;
  return text.split(/\r?\n/).length;
}
