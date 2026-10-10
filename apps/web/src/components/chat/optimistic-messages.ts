import { messageSignature } from "./format";
import type { ChatMessage } from "./message-model";

export type OptimisticMessage = {
  clientId: string;
  conversationId: string | null;
  expectedMatchCount: number;
  signature: string;
  message: ChatMessage;
};

function confirmedCount(messages: ChatMessage[], signature: string) {
  return messages.filter((message) =>
    message.role === "user" && messageSignature(message) === signature).length;
}

export function nextExpectedMatchCount(
  items: OptimisticMessage[],
  conversationId: string | null,
  signature: string,
  messages: ChatMessage[],
) {
  const confirmed = confirmedCount(messages, signature);
  const highestPending = items.reduce((highest, item) =>
    item.conversationId === conversationId && item.signature === signature
      ? Math.max(highest, item.expectedMatchCount)
      : highest, 0);
  return Math.max(confirmed, highestPending) + 1;
}

export function pendingOptimisticMessages(
  items: OptimisticMessage[],
  conversationId: string | null,
  messages: ChatMessage[],
) {
  return items.filter((item) => item.conversationId === conversationId &&
    confirmedCount(messages, item.signature) < item.expectedMatchCount);
}

export function pruneConfirmedOptimisticMessages(
  items: OptimisticMessage[],
  conversationId: string | null,
  messages: ChatMessage[],
) {
  return items.filter((item) => item.conversationId !== conversationId ||
    confirmedCount(messages, item.signature) < item.expectedMatchCount);
}
