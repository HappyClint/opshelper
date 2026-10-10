import type { ChatMessage, ChatPart } from "./message-model";

export interface StreamText {
  messageId: string;
  partId: string;
  text: string;
}

export interface ConversationStreamState {
  conversationId: string | null;
  revision: number;
  parts: Map<string, StreamText>;
}

export function createConversationStreamState(
  conversationId: string | null,
): ConversationStreamState {
  return { conversationId, revision: 0, parts: new Map() };
}

function partKey(messageId: string, partId: string) {
  return JSON.stringify([messageId, partId]);
}

/** The server sends cumulative, sanitized text, not an append-only delta. */
export function receiveStreamText(
  state: ConversationStreamState,
  conversationId: string,
  payload: unknown,
): ConversationStreamState {
  if (state.conversationId !== conversationId || !payload || typeof payload !== "object") {
    return state;
  }
  const { messageId, partId, text } = payload as Partial<StreamText>;
  if (typeof messageId !== "string" || !messageId ||
      typeof partId !== "string" || !partId || typeof text !== "string") {
    return state;
  }
  const key = partKey(messageId, partId);
  const previous = state.parts.get(key);
  // A reconnect can replay an older seed. Never shorten already displayed text
  // to an earlier prefix; actual revisions are reconciled by the final snapshot.
  if (previous && previous.text.startsWith(text)) return state;
  const parts = new Map(state.parts);
  parts.set(key, { messageId, partId, text });
  return { ...state, revision: state.revision + 1, parts };
}

function streamedPart(event: StreamText, existing?: ChatPart): ChatPart {
  return {
    ...existing,
    id: event.partId,
    type: "text",
    text: event.text,
    raw: { ...existing?.raw, id: event.partId, type: "text", text: event.text },
  };
}

/** Overlay new text on snapshots that can lag behind the event connection. */
export function mergeStreamMessages(
  messages: ChatMessage[],
  state: ConversationStreamState,
  conversationId: string | null,
): ChatMessage[] {
  if (state.conversationId !== conversationId || state.parts.size === 0) return messages;
  const result = messages.slice();
  const positions = new Map(result.map((message, index) => [message.id, index]));
  for (const event of state.parts.values()) {
    let index = positions.get(event.messageId);
    if (index === undefined) {
      index = result.length;
      positions.set(event.messageId, index);
      result.push({
        id: event.messageId,
        role: "assistant",
        order: Number.MAX_SAFE_INTEGER,
        parts: [],
      });
    }
    const message = result[index];
    if (message.role !== "assistant") continue;
    const partIndex = message.parts.findIndex((part) => part.id === event.partId);
    const existing = message.parts[partIndex];
    if (existing?.text.startsWith(event.text)) continue;
    const parts = message.parts.slice();
    const part = streamedPart(event, existing);
    if (partIndex < 0) parts.push(part);
    else parts[partIndex] = part;
    result[index] = { ...message, parts };
  }
  return result;
}

/** Retire overlays after a fresh terminal snapshot catches up or marks a part complete. */
export function settleStreamSnapshot(
  state: ConversationStreamState,
  conversationId: string,
  messages: ChatMessage[],
  requestRevision: number,
  terminal: boolean,
): ConversationStreamState {
  if (state.conversationId !== conversationId || !terminal ||
      requestRevision !== state.revision || state.parts.size === 0) return state;
  const snapshotParts = new Map(messages.flatMap((message) =>
    message.role === "assistant"
      ? message.parts.map((part) => [partKey(message.id, part.id), part] as const)
      : []));
  const parts = new Map(state.parts);
  for (const [key, event] of parts) {
    const part = snapshotParts.get(key);
    if (!part) continue;
    const completedAt = part.raw?.time?.end;
    const complete = typeof completedAt === "number" && Number.isFinite(completedAt);
    // Completed text can be trimmed or revised by the runtime. A terminal
    // execution alone is insufficient: its message snapshot can still lag.
    if (!complete && !part.text.startsWith(event.text)) continue;
    parts.delete(key);
  }
  return parts.size === state.parts.size ? state : { ...state, parts };
}
