import type { Attachment } from "./types";

export type ConversationDraft = { input: string; attachments: Attachment[] };
export type ConversationDrafts = Record<string, ConversationDraft>;
export const EMPTY_DRAFT: ConversationDraft = { input: "", attachments: [] };

export function conversationDraftKey(conversationId: string | null, agentKey: string | null) {
  return conversationId ? `conversation:${conversationId}` : `new:${agentKey ?? ""}`;
}

export function hasDraft(draft: ConversationDraft | undefined) {
  return Boolean(draft && (draft.input.length > 0 || draft.attachments.length > 0));
}

export function updateConversationDraft(
  drafts: ConversationDrafts,
  key: string,
  update: (draft: ConversationDraft) => ConversationDraft,
): ConversationDrafts {
  const next = { ...drafts };
  const draft = update(drafts[key] ?? EMPTY_DRAFT);
  if (hasDraft(draft)) next[key] = draft;
  else delete next[key];
  return next;
}

export function moveConversationDraft(drafts: ConversationDrafts, from: string, to: string): ConversationDrafts {
  if (from === to || !drafts[from]) return drafts;
  const next = { ...drafts, [to]: drafts[from] };
  delete next[from];
  return next;
}

function readyAttachment(value: unknown): value is Attachment {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<Attachment>;
  return item.status === "ready" && typeof item.id === "string" &&
    typeof item.path === "string" && item.path.startsWith("/workspace/") &&
    typeof item.filename === "string" && typeof item.mime === "string" &&
    (item.source === "upload" || item.source === "mention");
}

export function parseConversationDrafts(raw: string | null): ConversationDrafts {
  try {
    const parsed: unknown = JSON.parse(raw ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const drafts: ConversationDrafts = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!key.startsWith("conversation:") && !key.startsWith("new:")) continue;
      if (!value || typeof value !== "object") continue;
      const saved = value as Partial<ConversationDraft>;
      const draft = {
        input: typeof saved.input === "string" ? saved.input : "",
        attachments: Array.isArray(saved.attachments) ? saved.attachments.filter(readyAttachment) : [],
      };
      if (hasDraft(draft)) drafts[key] = draft;
    }
    return drafts;
  } catch {
    return {};
  }
}

export function serializeConversationDrafts(drafts: ConversationDrafts) {
  // Uploading/error entries are session-only; after a reload only usable files return.
  return JSON.stringify(Object.fromEntries(Object.entries(drafts).flatMap(([key, draft]) => {
    const saved = { input: draft.input, attachments: draft.attachments.filter(readyAttachment) };
    return hasDraft(saved) ? [[key, saved]] : [];
  })));
}

export function conversationDraftStorageKey(userKey: string) {
  return `opshelper:chat-drafts:${encodeURIComponent(userKey)}`;
}
