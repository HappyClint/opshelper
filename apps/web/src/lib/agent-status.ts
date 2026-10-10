import type { AgentCheckStatus, AgentMode } from "@opshelper/shared";

// 目录卡片要表达三种彼此独立的状态：角色模式（这是什么角色）、启用状态（现在能不能
// 用）、依赖检查（配置是否检查通过）。它们各自取值，所以统一在这里给出文案与语气，
// 避免卡片里出现“看着像成功其实是角色模式”的第三套绿色。

export type AgentStateTone = "neutral" | "positive" | "prompt" | "danger";

export interface AgentStateView {
  label: string;
  tone: AgentStateTone;
}

const MODE_LABELS: Record<AgentMode, string> = {
  primary: "主智能体",
  subagent: "子智能体",
  all: "主/子智能体",
};

const CHECK_LABELS: Record<AgentCheckStatus, string> = {
  ready: "检查通过",
  pending: "待检查",
  error: "检查失败",
};

const CHECK_TONES: Record<AgentCheckStatus, AgentStateTone> = {
  ready: "positive",
  pending: "prompt",
  error: "danger",
};

/** 角色模式是中性的结构信息，不使用成功色。 */
export function agentModeView(mode: AgentMode): AgentStateView {
  return { label: MODE_LABELS[mode] ?? mode, tone: "neutral" };
}

/** 启用只说明智能体开关打开，不代表依赖检查已经通过。 */
export function agentEnabledView(isEnabled: boolean): AgentStateView {
  return isEnabled
    ? { label: "启用", tone: "positive" }
    : { label: "停用", tone: "neutral" };
}

/** 检查状态与启用状态分开表达：失败必须有文字，不能只靠颜色。 */
export function agentCheckView(checkStatus: AgentCheckStatus): AgentStateView {
  return {
    label: CHECK_LABELS[checkStatus] ?? checkStatus,
    tone: CHECK_TONES[checkStatus] ?? "prompt",
  };
}

export function agentAssignmentLabel(assignmentCount: number) {
  return `${assignmentCount} 人获配`;
}

/** 目录计数：搜索时区分“命中数”与“总数”，避免把两者当成同一个数字。 */
export function agentCatalogCount(total: number, matched: number, searching: boolean) {
  return searching ? `匹配 ${matched} 个 / 共 ${total} 个` : `共 ${total} 个智能体`;
}
