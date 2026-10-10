/**
 * Normalizes opencode's interactive prompts — model-initiated questions
 * (`question.asked`) and tool/command authorization requests
 * (`permission.updated`) — into stable shapes the chat UI can render.
 *
 * As with message-model.ts, every accessor is defensive: the exact event
 * payloads vary by opencode version (see the opshelper plan's "待确认" note).
 */

import type {
  OpencodePermission,
  OpencodeQuestionItem,
  OpencodeQuestionOption,
  OpencodeQuestionRequest,
} from "@/lib/opencode-client";

// ---- Questions -------------------------------------------------------------

export interface PendingQuestion {
  id: string;
  sessionId?: string;
  questions: OpencodeQuestionItem[];
}

function normalizeOption(raw: any): OpencodeQuestionOption | null {
  if (raw == null) return null;
  if (typeof raw === "string") return { label: raw };
  const label = raw.label ?? raw.value ?? raw.title ?? raw.text;
  if (label == null) return null;
  return { label: String(label), description: raw.description ?? raw.detail };
}

function normalizeItem(raw: any): OpencodeQuestionItem {
  const options = Array.isArray(raw?.options)
    ? raw.options.map(normalizeOption).filter(Boolean)
    : [];
  return {
    header: raw?.header ?? raw?.title,
    question: String(raw?.question ?? raw?.header ?? raw?.prompt ?? ""),
    options: options as OpencodeQuestionOption[],
    multiple: Boolean(raw?.multiple ?? raw?.multiSelect),
    custom: Boolean(raw?.custom ?? raw?.allowCustom ?? true),
  };
}

/**
 * Pull the request out of a `question.asked` event (whose `properties` IS the
 * request) or a `GET /question` list item. Verified against opencode 1.17.7:
 * { id, sessionID, questions: [{ header, question, options:[{label,description}],
 * multiple?, custom? }] }.
 */
export function normalizeQuestion(raw: any): PendingQuestion | null {
  const req: OpencodeQuestionRequest | undefined =
    raw?.properties ?? raw?.question ?? raw?.request ?? raw;
  const id = req?.id ?? raw?.requestId ?? raw?.id;
  const items = Array.isArray(req?.questions) ? req!.questions : [];
  if (!id || items.length === 0) return null;
  return {
    id: String(id),
    sessionId: req?.sessionID ?? raw?.sessionID,
    questions: items.map(normalizeItem),
  };
}

// ---- Permissions -----------------------------------------------------------

export interface PendingPermission {
  id: string;
  sessionId: string;
  /** Human-readable request, e.g. "Run echo hello". */
  title: string;
  /** Permission kind opencode reports: "bash" | "edit" | "read" | … */
  tool?: string;
  /** A short preview of the command / pattern awaiting approval. */
  detail?: string;
}

function previewDetail(p: OpencodePermission): string | undefined {
  const m = (p.metadata ?? {}) as Record<string, unknown>;
  const candidate = m.command ?? m.cmd ?? m.input ?? m.path ?? m.filePath;
  if (typeof candidate === "string") return candidate;
  if (Array.isArray(p.patterns) && p.patterns.length > 0) {
    return p.patterns.join("\n");
  }
  return undefined;
}

/**
 * Pull the permission out of a `permission.asked` event (whose `properties` IS
 * the permission object) or a `GET /permission` list item. Fields verified
 * against opencode 1.17.7: { id, sessionID, permission, patterns, metadata }.
 */
export function normalizePermission(raw: any): PendingPermission | null {
  const p: OpencodePermission | undefined = raw?.properties ?? raw;
  const id = p?.id;
  const sessionId = p?.sessionID;
  if (!id || !sessionId) return null;
  const kind = typeof p?.permission === "string" ? p.permission : undefined;
  const description = (p?.metadata as any)?.description;
  return {
    id: String(id),
    sessionId: String(sessionId),
    title: String(description ?? kind ?? "请求授权"),
    tool: kind,
    detail: previewDetail(p),
  };
}
