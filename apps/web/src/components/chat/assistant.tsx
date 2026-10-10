// 纯解析逻辑（Assistant 类型 + 列表构建 + 角色与首屏示例）在 assistants.ts；这里只
// 保留视觉部分（AgentMark）并 re-export 以保持现有导入。
export {
  type AgentIconKind,
  type AgentRole,
  type Assistant,
  type StarterExample,
  FALLBACK_ASSISTANTS,
  DEFAULT_ASSISTANT_ID,
  agentIconKind,
  agentRole,
  starterExamplesFor,
  assistantsFromConfig,
  assistantsFromAgents,
} from "./assistants";

import { agentIconKind } from "./assistants";
import {
  IconAgent,
  IconRoleDatabase,
  IconRoleDiagnostics,
  IconRoleNetwork,
  IconRolePerson,
  IconRoleSystem,
  IconRoleTeam,
  IconShield,
} from "./icons";

const AGENT_ICONS = {
  network: IconRoleNetwork,
  system: IconRoleSystem,
  person: IconRolePerson,
  team: IconRoleTeam,
  diagnostics: IconRoleDiagnostics,
  database: IconRoleDatabase,
  security: IconShield,
  generic: IconAgent,
} as const;

// AgentMark = 当前智能体的角色标识。图标完全由 id / 名称 / 职责推导，所以管理员新建
// 的智能体也有稳定的标识，不需要额外的头像配置。同一智能体在选择器、顶栏、首屏和
// 目录里都是同一个图形（角色相同时图形相同，颜色保持品牌浅绿）。
export function AgentMark({
  id,
  name = "",
  description = "",
}: {
  id: string;
  name?: string;
  description?: string;
}) {
  const kind = agentIconKind({ id, name, description });
  const Icon = AGENT_ICONS[kind];
  return (
    <span className={`opshelper-agent-mark opshelper-agent-mark-${kind}`} aria-hidden="true">
      <Icon />
    </span>
  );
}
