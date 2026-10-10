import type { OpencodeAgentInfo, OpencodeConfig } from "@/lib/opencode-client";

// Assistants come from the user's applied data/agents subset. The only runtime
// fields we can rely on are the agent id and description, so visuals are derived.
// 这个模块只包含纯解析逻辑，视觉部分（Avatar 等）留在 assistant.tsx。
export interface Assistant {
  id: string;
  name: string;
  description: string; // shown as a subtitle so users can tell assistants apart
  prompts?: string[]; // optional admin-provided starter prompts (see below)
  agent?: string;
}

// Used only until the live config arrives; these mirror the sample config.
export const FALLBACK_ASSISTANTS: Assistant[] = [
  { id: "assistant", name: "小信助理", description: "通用问答与综合任务", agent: "assistant" },
];

export const DEFAULT_ASSISTANT_ID = FALLBACK_ASSISTANTS[0].id;

// 角色标识：网络、系统、个人、团队，以及判断不出职责时的通用图标。
export type AgentRole = "network" | "system" | "person" | "team" | "generic";

// 只按稳定标识（key、名称、职责说明）判断角色。判不出来就用通用图标，不要靠名字
// 猜能力：猜错会让用户以为这个智能体能做它实际做不到的事。
// 网络排在系统之前，因为网络排查的说明里常出现“服务访问”这类词。
// 英文关键词必须是独立词；短横线、下划线也可作为 key 的分隔符，避免 log 命中 blog/catalog。
const ROLE_MATCHERS: ReadonlyArray<readonly [AgentRole, RegExp]> = [
  ["network", /网络|连通|联通|路由|代理|(?:^|[^a-z0-9])(?:network|dns|routes?|proxy)(?=$|[^a-z0-9])/i],
  ["system", /系统|主机|服务器|进程|磁盘|容器|日志|(?:^|[^a-z0-9])(?:servers?|sysops|system-ops|logs?)(?=$|[^a-z0-9])/i],
  ["team", /共享|团队|协作|验收|(?:^|[^a-z0-9])(?:shared|team|acceptance)(?=$|[^a-z0-9])/i],
  ["person", /助理|个人|(?:^|[^a-z0-9])(?:assistant|personal)(?=$|[^a-z0-9])/i],
];

export function agentRole(agent: Pick<Assistant, "id" | "name" | "description">): AgentRole {
  const haystack = `${agent.id}\n${agent.name}\n${agent.description}`;
  for (const [role, pattern] of ROLE_MATCHERS) {
    if (pattern.test(haystack)) return role;
  }
  return "generic";
}

// 图标分类只影响外观，首屏任务示例继续使用原有角色规则。
export type AgentIconKind = AgentRole | "diagnostics" | "database" | "security";

const ICON_MATCHERS: ReadonlyArray<readonly [AgentIconKind, RegExp]> = [
  ["security", /安全|防火墙|漏洞|攻防|(?:^|[^a-z0-9])(?:security|cybersecurity|infosec|firewall|vulnerabilities|vulnerability)(?=$|[^a-z0-9])/i],
  ["database", /数据库|数仓|数据仓库|(?:^|[^a-z0-9])(?:databases?|db|dba|sql|mysql|postgres(?:ql)?|mariadb|mongodb|redis|oracle|sqlserver|mssql|db2)(?=$|[^a-z0-9])/i],
  ["diagnostics", /故障|根因|诊断|异常分析|告警分析|(?:^|[^a-z0-9])(?:faults?|incidents?|diagnostics?|diagnosis|troubleshoot(?:ing|er)?|rca|root[\s_-]+cause)(?=$|[^a-z0-9])/i],
  ["team", /班组|综合员|班务|综合事务|值班管理|值班协调|(?:^|[^a-z0-9])(?:shift[\s_-]+coordinator|team[\s_-]+coordinator)(?=$|[^a-z0-9])/i],
  ...ROLE_MATCHERS,
];

export function agentIconKind(agent: Pick<Assistant, "id" | "name" | "description">): AgentIconKind {
  // 名称与 key 比说明中偶尔提到的领域更明确；同一来源中专门领域优先于通用角色。
  for (const text of [`${agent.id}\n${agent.name}`, agent.description]) {
    for (const [kind, pattern] of ICON_MATCHERS) {
      if (pattern.test(text)) return kind;
    }
  }
  return "generic";
}

// 首屏示例分两段：入口标题（按钮上显示的短句）与点击后填入输入框的文字。
export type StarterExample = { title: string; text: string };

// 职责未知时的通用入口：让智能体自己说明能力，比替它承诺一个未经确认的运维任务安全。
const UNIVERSAL_PROMPTS: StarterExample[] = [
  { title: "它能做什么", text: "介绍一下你能做什么" },
  { title: "能处理哪些任务", text: "你能帮我处理哪些任务？" },
  { title: "看一个使用示例", text: "给我一个使用示例" },
];

const ROLE_EXAMPLES: Record<Exclude<AgentRole, "person" | "generic">, StarterExample[]> = {
  network: [
    { title: "排查网络访问", text: "帮我排查目标服务访问失败，需要哪些信息？" },
    { title: "检查 DNS 解析", text: "域名解析异常，帮我按步骤确认本地 DNS 和解析结果。" },
    { title: "确认端口连通", text: "帮我确认目标端口是否可达，以及应该用哪些命令验证。" },
  ],
  system: [
    { title: "分析错误日志", text: "帮我分析这段日志，找出异常原因和下一步排查建议。" },
    { title: "排查服务异常", text: "服务没有正常启动，帮我按顺序核对资源占用和进程状态。" },
    { title: "整理巡检项", text: "帮我整理这台主机需要定期检查的项目和对应命令。" },
  ],
  team: [
    { title: "核对角色定义", text: "帮我检查这个智能体的角色定义和文件是否一致。" },
    { title: "检查配置差异", text: "帮我对比两套配置的差异，并说明可能的影响。" },
    { title: "确认共享边界", text: "帮我确认跨用户共享时的隔离边界和验收要点。" },
  ],
};

const MAX_STARTERS = 3;

/**
 * 首屏任务示例：管理员显式配置的示例优先；否则按角色给出具体任务；
 * 角色未知时退回能力询问入口。最多三条，点击后只填入输入框，不自动执行。
 */
export function starterExamplesFor(assistant: Assistant): StarterExample[] {
  if (assistant.prompts && assistant.prompts.length > 0) {
    // 管理员给的示例只有正文，入口标题沿用同一句，不再另拟文案。
    return assistant.prompts.slice(0, MAX_STARTERS).map((text) => ({ title: text, text }));
  }
  const role = agentRole(assistant);
  // 角色明确时给具体任务；职责未知时不替它承诺运维动作，改成让它自己说明能力。
  const examples = role === "person" || role === "generic" ? UNIVERSAL_PROMPTS : ROLE_EXAMPLES[role];
  return examples.slice(0, MAX_STARTERS);
}

// Admin-provided starter prompts can arrive in two shapes:
//  - GET /config: the raw agent map, so `prompts` sits at the top level.
//  - GET /agent: opencode parses each agent and tucks keys it doesn't model
//    itself (like our `prompts`) under an `options` bag — verified against
//    1.17.x, where a markdown agent's `prompts:` frontmatter surfaces as
//    `options.prompts`. So we read both locations.
function extractPrompts(record: Record<string, unknown>): string[] | undefined {
  const options =
    record.options && typeof record.options === "object"
      ? (record.options as Record<string, unknown>)
      : {};
  for (const candidate of [record.prompts, options.prompts]) {
    if (Array.isArray(candidate)) {
      const list = candidate.filter(
        (p): p is string => typeof p === "string" && p.trim().length > 0,
      );
      if (list.length > 0) return list;
    }
  }
  return undefined;
}

function assistantFromConfigEntry(id: string, entry: unknown): Assistant {
  const record = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
  const rawDescription = typeof record.description === "string" ? record.description : "";
  // Convention: description is "名称 — 简介"; fall back to the id for the name.
  const [rawName, ...rest] = rawDescription.split(/\s+[—-]\s+/);
  const name = rawName.trim() || id;
  const description = rest.join(" — ").trim();
  const prompts = extractPrompts(record);

  return { id, name, description, prompts, agent: id };
}

export function assistantsFromConfig(config: OpencodeConfig): Assistant[] {
  return Object.entries(config.agent ?? {}).map(([id, entry]) =>
    assistantFromConfigEntry(id, entry),
  );
}

// 从 opencode `GET /agent` 的已解析列表构建助理。过滤掉:
//   - native: 内置 agent（build/plan/general/explore…），opshelper 只展示自定义助理；
//   - hidden: compaction/title/summary 等内部 agent；
//   - mode==="subagent": 子智能体只被其他智能体调用，不作为可主选助理。
export function assistantsFromAgents(agents: OpencodeAgentInfo[]): Assistant[] {
  return agents
    .filter(
      (a) =>
        a &&
        typeof a.name === "string" &&
        !a.native &&
        !a.hidden &&
        a.mode !== "subagent",
    )
    .map((a) => assistantFromConfigEntry(a.name, a));
}
