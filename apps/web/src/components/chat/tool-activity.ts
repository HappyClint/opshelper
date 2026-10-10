import type { ChatPart, ChatTool } from "./message-model";

export type OperationKind =
  | "read"
  | "search"
  | "change"
  | "command"
  | "network"
  | "integration"
  | "skill"
  | "delegate"
  | "other";

export type OperationStatus = "pending" | "running" | "completed" | "failed";

export interface ToolOperation {
  id: string;
  toolName: string;
  kind: OperationKind;
  status: OperationStatus;
  label: string;
  target: string | null;
  result: string | null;
  input: unknown;
  output: string;
  durationMs: number | null;
  outsideWorkspace: boolean;
  changesState: boolean;
  externalAccess: boolean;
  skillName: string | null;
}

export interface OperationCategory {
  kind: OperationKind;
  label: string;
  count: number;
  emphasis: "neutral" | "notice" | "warning";
}

const failedStatuses = new Set(["error", "failed", "cancelled", "canceled", "denied", "rejected"]);
const runningStatuses = new Set(["running", "in_progress", "in-progress"]);
const completedStatuses = new Set(["completed", "complete", "success", "succeeded", "done"]);

const kindLabels: Record<OperationKind, string> = {
  read: "查看",
  search: "搜索",
  change: "修改",
  command: "命令",
  network: "联网",
  integration: "扩展",
  skill: "技能",
  delegate: "协作",
  other: "其他",
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized || null;
}

function firstText(source: unknown, keys: string[]): string | null {
  const value = record(source);
  for (const key of keys) {
    const candidate = text(value[key]);
    if (candidate) return candidate;
  }
  return null;
}

function clipped(value: string | null, limit = 180) {
  if (!value || value.length <= limit) return value;
  return `${value.slice(0, limit - 1)}…`;
}

function normalizedName(value: string) {
  return value.trim().toLowerCase().replace(/[.-]/g, "_");
}

function includesName(name: string, values: string[]) {
  return values.some((value) => name === value || name.endsWith(`_${value}`));
}

function looksLikeIntegrationTool(toolName: string) {
  // Managed MCP names are `${agentKey}-${serverKey}_${toolName}` and therefore
  // contain a hyphen before the first underscore. Built-ins such as
  // `apply_patch` must keep their native category.
  return /^[a-z][a-z0-9]*-[a-z0-9-]+_[a-z0-9]/i.test(toolName.trim());
}

export function operationStatus(status: string): OperationStatus {
  const normalized = normalizedName(status);
  if (failedStatuses.has(normalized)) return "failed";
  if (runningStatuses.has(normalized)) return "running";
  if (completedStatuses.has(normalized)) return "completed";
  return "pending";
}

export function operationKind(toolName: string, input?: unknown): OperationKind {
  const name = normalizedName(toolName);
  if (includesName(name, ["skill"])) return "skill";
  if (includesName(name, ["task", "delegate", "subagent"])) return "delegate";
  if (includesName(name, ["webfetch", "websearch", "web_search", "http", "fetch", "browser", "crawl", "scrape"]) ||
    /(^|_)(web|http|fetch|browser|crawl|scrape)(_|$)/.test(name)) return "network";
  if (looksLikeIntegrationTool(toolName)) return "integration";
  if (includesName(name, ["read", "cat", "open_file", "list", "ls"])) return "read";
  if (includesName(name, ["glob", "grep", "search", "find", "ripgrep"])) return "search";
  if (includesName(name, ["write", "edit", "patch", "apply_patch", "delete", "remove", "move", "rename"])) {
    return "change";
  }
  if (includesName(name, ["bash", "shell", "command", "terminal", "exec", "execute"])) return "command";

  const command = firstText(input, ["command", "cmd"]);
  if (command && /(^|\s)(curl|wget|ssh|scp|rsync)\b/i.test(command)) return "command";
  return "other";
}

export function toolDisplayName(toolName: string) {
  const kind = operationKind(toolName);
  const labels: Record<OperationKind, string> = {
    read: "查看文件",
    search: "搜索内容",
    change: "修改内容",
    command: "执行命令",
    network: "访问外部服务",
    integration: "调用扩展工具",
    skill: "使用技能",
    delegate: "委派协作任务",
    other: "执行工具",
  };
  return labels[kind];
}

function readDisplay(tool: ChatTool) {
  const display = record(record(tool.metadata).display);
  return {
    type: text(display.type),
    path: text(display.path),
    totalEntries: typeof display.totalEntries === "number" ? display.totalEntries : null,
  };
}

function skillName(tool: ChatTool, agentKey?: string) {
  const raw = firstText(tool.input, ["name", "skill", "skillName"]);
  if (!raw) return null;
  const prefix = agentKey ? `${agentKey}-` : "";
  return prefix && raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
}

function operationLabel(kind: OperationKind, tool: ChatTool) {
  if (kind === "read") {
    return readDisplay(tool).type === "directory" ? "查看目录" : "读取文件";
  }
  const labels: Record<Exclude<OperationKind, "read">, string> = {
    search: "搜索文件或内容",
    change: "修改文件",
    command: "执行命令",
    network: "访问外部服务",
    integration: "调用扩展工具",
    skill: "使用技能",
    delegate: "委派协作任务",
    other: "执行工具",
  };
  return labels[kind];
}

function operationTarget(kind: OperationKind, tool: ChatTool, agentKey?: string) {
  const input = record(tool.input);
  const display = readDisplay(tool);
  if (kind === "skill") return skillName(tool, agentKey);
  if (kind === "read") {
    return clipped(display.path ?? firstText(input, ["filePath", "filepath", "path", "filename"]));
  }
  if (kind === "search") {
    const pattern = firstText(input, ["pattern", "query", "search", "text"]);
    const path = firstText(input, ["path", "filePath", "directory", "cwd"]);
    return clipped([pattern, path].filter(Boolean).join(" · ") || null);
  }
  if (kind === "change") {
    return clipped(firstText(input, ["filePath", "filepath", "path", "filename", "destination", "target"]));
  }
  if (kind === "command") {
    return clipped(firstText(input, ["command", "cmd", "description"]) ?? text(tool.title), 220);
  }
  if (kind === "network") {
    return clipped(firstText(input, ["url", "query", "path", "endpoint", "host"]) ?? text(tool.title));
  }
  if (kind === "integration") {
    return clipped(firstText(input, ["description", "title", "query", "path", "name"]) ?? text(tool.title));
  }
  if (kind === "delegate") {
    return clipped(firstText(input, ["description", "title", "prompt", "task", "subagent_type"]) ?? text(tool.title));
  }
  return clipped(text(tool.title) ?? firstText(input, ["description", "path", "query", "name"]));
}

function operationResult(kind: OperationKind, tool: ChatTool) {
  const metadata = record(tool.metadata);
  const display = readDisplay(tool);
  if (kind === "read" && display.totalEntries !== null) return `${display.totalEntries} 项`;
  for (const key of ["count", "matches", "resultCount", "total"]) {
    if (typeof metadata[key] === "number") return `${metadata[key]} 个结果`;
  }
  return null;
}

function duration(tool: ChatTool) {
  const time = record(tool.time);
  const start = typeof time.start === "number" ? time.start : null;
  const end = typeof time.end === "number" ? time.end : null;
  return start !== null && end !== null && end >= start ? end - start : null;
}

function operationPath(kind: OperationKind, tool: ChatTool) {
  if (kind === "read") {
    return readDisplay(tool).path ?? firstText(tool.input, ["filePath", "filepath", "path"]);
  }
  if (kind === "search") {
    return firstText(tool.input, ["path", "filePath", "directory", "cwd"]);
  }
  if (kind === "change") {
    return firstText(tool.input, ["filePath", "filepath", "path", "destination", "target"]);
  }
  return null;
}

function pathOutsideWorkspace(path: string | null) {
  if (!path) return false;
  const normalized = path.replace(/^file:\/\//, "");
  if (normalized === ".." || normalized.startsWith("../") || normalized === "~" || normalized.startsWith("~/")) return true;
  return normalized.startsWith("/") && normalized !== "/workspace" && !normalized.startsWith("/workspace/");
}

function commandUsesNetwork(tool: ChatTool) {
  const command = firstText(tool.input, ["command", "cmd"]);
  return Boolean(command && /(^|\s)(curl|wget|ssh|scp|rsync)\b/i.test(command));
}

export function toolOperation(part: ChatPart, agentKey?: string): ToolOperation | null {
  const tool = part.tool;
  if (!tool) return null;
  const kind = operationKind(tool.name, tool.input);
  const target = operationTarget(kind, tool, agentKey);
  const outsideWorkspace = pathOutsideWorkspace(operationPath(kind, tool));
  return {
    id: part.id,
    toolName: tool.name,
    kind,
    status: operationStatus(tool.status),
    label: operationLabel(kind, tool),
    target,
    result: operationResult(kind, tool),
    input: tool.input,
    output: tool.output,
    durationMs: duration(tool),
    outsideWorkspace,
    changesState: kind === "change" || kind === "command",
    externalAccess: kind === "network" || kind === "integration" || commandUsesNetwork(tool),
    skillName: kind === "skill" ? skillName(tool, agentKey) : null,
  };
}

export function operationsFromParts(parts: ChatPart[], agentKey?: string) {
  return parts.flatMap((part) => {
    const operation = toolOperation(part, agentKey);
    return operation ? [operation] : [];
  });
}

export function operationCategories(operations: ToolOperation[]): OperationCategory[] {
  const counts = new Map<OperationKind, number>();
  for (const operation of operations) {
    counts.set(operation.kind, (counts.get(operation.kind) ?? 0) + 1);
  }
  return (["read", "search", "change", "command", "network", "integration", "skill", "delegate", "other"] as const)
    .flatMap((kind) => {
      const count = counts.get(kind) ?? 0;
      if (!count) return [];
      return [{
        kind,
        label: kindLabels[kind],
        count,
        emphasis: kind === "change" || kind === "command" || kind === "network" || kind === "integration"
          ? "notice" as const
          : "neutral" as const,
      }];
    });
}

export function operationSummary(operations: ToolOperation[]) {
  const failed = operations.filter((operation) => operation.status === "failed").length;
  const active = operations.filter((operation) => operation.status === "running").length;
  const pending = operations.filter((operation) => operation.status === "pending").length;
  if (failed) return `${failed} 项操作失败`;
  if (active) return `正在执行 ${active} 项操作`;
  if (pending) return `${pending} 项操作等待执行`;
  return `已完成 ${operations.length} 项操作`;
}

export function operationStatusLabel(status: OperationStatus) {
  const labels: Record<OperationStatus, string> = {
    pending: "等待执行",
    running: "执行中",
    completed: "已完成",
    failed: "失败",
  };
  return labels[status];
}
