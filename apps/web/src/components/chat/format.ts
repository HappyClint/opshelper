import type { ChatMessage, ChatPart } from "./message-model";

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  html: "text/html",
  js: "text/javascript",
  ts: "text/plain",
  py: "text/x-python",
};

export function guessMime(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

export function basename(path: string): string {
  return path.replace(/\/+$/, "").split("/").pop() || path;
}

export function fullConversationTitle(raw: string) {
  // opencode auto-titles new sessions "New session - <ISO>"; show a friendlier
  // label until the model renames it.
  const text = String(raw);
  if (/^New session/i.test(text)) return "新的对话";
  return text;
}

export function cleanTitle(raw: string) {
  const text = fullConversationTitle(raw);
  return text.length > 32 ? `${text.slice(0, 32)}…` : text;
}

export function formatConversationTime(value: string, now = new Date()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const sameDay = date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  if (sameDay) {
    return new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  }
  if (date.getFullYear() === now.getFullYear()) {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "numeric",
      day: "numeric",
    }).format(date);
  }
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).format(date);
}

// 侧栏时间列只放「21:40 / 9/16」这种刚够定位的写法，完整时间放在 title 里：
// 同一天内的多条会话（标题常重复）只能靠它区分。
export function formatConversationTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "long",
    timeStyle: "short",
  }).format(date);
}

export function partsText(parts: ChatPart[]) {
  return parts.map((p) => p.text).join("");
}

// Filenames of file parts on a (user) message, so the chat echoes what was
// attached even though file parts carry no text.
export function fileAttachments(parts: ChatPart[]): string[] {
  return parts
    .filter((p) => p.type === "file")
    .map((p) => {
      const raw = p.raw as { filename?: string; url?: string } | undefined;
      const name = raw?.filename || (raw?.url ? basename(raw.url) : "");
      return name;
    })
    .filter((name): name is string => Boolean(name));
}

// Reasoning stays internal. Tool parts are rendered once in the structured
// operation record rather than mixed into the model's prose.
export function partHasUserFacingContent(part: ChatPart) {
  return !part.tool && part.type !== "reasoning" && part.text.trim().length > 0;
}

export function messageHasContent(message: ChatMessage): boolean {
  return message.parts.some((part) => partHasUserFacingContent(part) || Boolean(part.tool));
}

export function messageSignature(message: ChatMessage) {
  return JSON.stringify({
    text: partsText(message.parts).trim(),
    files: fileAttachments(message.parts),
  });
}

export function describeOpencodeError(error: unknown): string {
  if (!error) return "未知错误";
  if (typeof error === "string") return error;
  const e = error as { name?: string; data?: { message?: string }; message?: string };
  return e.data?.message ?? e.message ?? e.name ?? "未知错误";
}

/**
 * 管理员新增/修改模型后、用户容器还没重启时，容器内的 opencode 不认识新模型，
 * 会报「模型/供应商不存在」类错误（如 ProviderModelNotFoundError）。识别它，
 * 好把原始报错换成「重启工作台」的引导。字段形状随 opencode 版本变化，按
 * 错误名与消息文本模糊匹配（send 失败时只有拼进 Error.message 的响应文本）。
 */
export function isUnknownModelError(error: unknown): boolean {
  let text: string;
  if (typeof error === "string") {
    text = error;
  } else {
    const e = (error ?? {}) as {
      name?: string;
      data?: { message?: string };
      message?: string;
    };
    text = [e.name, e.data?.message, e.message].filter(Boolean).join(" ");
  }
  return /(model|provider)\s*not\s*found|(model|provider)notfounderror|unknown\s+(model|provider)/i.test(
    text,
  );
}

export function safeStringify(value: unknown) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
