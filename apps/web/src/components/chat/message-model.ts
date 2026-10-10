/**
 * Normalizes opencode message/part shapes into a stable model the chat UI can
 * render. opencode's exact event payloads vary by version, so every accessor
 * is defensive — see the opshelper plan's "待确认" note about confirming the schema
 * against a live `opencode serve`.
 */

export type ChatRole = "user" | "assistant";

export interface ChatTool {
  name: string;
  status: string;
  input: unknown;
  output: string;
  title?: string;
  metadata?: unknown;
  time?: unknown;
}

export interface ChatPart {
  id: string;
  type: string; // text | reasoning | tool | file | step-start ...
  text: string;
  tool?: ChatTool;
  raw: any;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  order: number;
  parts: ChatPart[];
  // 该轮失败时 opencode 挂在 message info 上的 error（原始对象，渲染时再转文案）。
  // 留在模型里，失败的一轮才能在对话流里留痕，而不是只弹一条易被清掉的 notice。
  error?: unknown;
}

export type MessageMap = Map<string, ChatMessage>;

let orderSeq = 0;
let partSeq = 0;

function stringify(value: unknown): string {
  if (value == null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function toTool(raw: any): ChatTool | undefined {
  const state = raw?.state ?? {};
  const name = raw?.tool ?? raw?.toolName ?? raw?.name ?? state?.name;
  if (!name && raw?.type !== "tool" && !String(raw?.type ?? "").startsWith("tool")) {
    return undefined;
  }
  return {
    name: String(name ?? "tool"),
    status: String(state?.status ?? raw?.status ?? "completed"),
    input: state?.input ?? raw?.input ?? raw?.args ?? null,
    output: stringify(state?.output ?? raw?.output ?? raw?.result ?? state?.error),
    title: typeof state?.title === "string"
      ? state.title
      : typeof raw?.title === "string"
        ? raw.title
        : undefined,
    metadata: state?.metadata ?? raw?.metadata,
    time: state?.time ?? raw?.time,
  };
}

export function toPart(raw: any): ChatPart {
  const type = String(raw?.type ?? "text");
  let text = "";
  if (typeof raw?.text === "string") {
    text = raw.text;
  } else if (typeof raw?.content === "string") {
    text = raw.content;
  }
  const isTool = type === "tool" || type.startsWith("tool") || raw?.tool || raw?.toolName;
  return {
    id: String(raw?.id ?? `part-${partSeq++}`),
    type,
    text,
    tool: isTool ? toTool(raw) : undefined,
    raw,
  };
}

/** Build the initial message map from GET /session/{id}/message. */
export function fromInitialMessages(items: any[]): MessageMap {
  const map: MessageMap = new Map();
  for (const item of items ?? []) {
    const info = item?.info ?? item;
    const id = info?.id ?? item?.id;
    if (!id) {
      continue;
    }
    const role: ChatRole = info?.role === "user" ? "user" : "assistant";
    const rawParts: any[] = item?.parts ?? info?.parts ?? [];
    map.set(id, {
      id,
      role,
      order: orderSeq++,
      parts: rawParts.map(toPart),
      error: info?.error,
    });
  }
  return map;
}

export function sortedMessages(map: MessageMap): ChatMessage[] {
  return [...map.values()].sort((a, b) => a.order - b.order);
}
