export type ConversationSurface = "new" | "loading" | "ready" | "unavailable";

export function resolveConversationSurface(
  activeConversationId: string | null,
  snapshotConversationId: string | null,
  failedConversationId: string | null,
): ConversationSurface {
  if (!activeConversationId) return "new";
  if (snapshotConversationId === activeConversationId) return "ready";
  return failedConversationId === activeConversationId ? "unavailable" : "loading";
}
