export type NewConversationRequest = {
  id: number;
  prefill: string;
};

export type NewConversationRequestAction = "ignore" | "apply" | "discard";

export function resolveNewConversationRequest(
  request: NewConversationRequest | null,
  activeConversationId: string | null,
): NewConversationRequestAction {
  if (!request) return "ignore";
  return activeConversationId ? "discard" : "apply";
}
