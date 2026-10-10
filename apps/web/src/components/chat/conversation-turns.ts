import type { ChatMessage, ChatPart } from "./message-model";

export interface ConversationTurn {
  key: string;
  role: ChatMessage["role"];
  messages: ChatMessage[];
}

/**
 * OpenCode emits one assistant message per tool step and another for the final
 * answer. Group adjacent assistant messages so one user request gets one
 * answer card with a single, truthful operation record.
 */
export function groupConversationTurns(messages: ChatMessage[]): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (const message of messages) {
    const previous = turns.at(-1);
    if (message.role === "assistant" && previous?.role === "assistant") {
      previous.messages.push(message);
      continue;
    }
    turns.push({ key: message.id, role: message.role, messages: [message] });
  }
  return turns;
}

export function turnParts(turn: ConversationTurn): ChatPart[] {
  return turn.messages.flatMap((message) => message.parts);
}

export function turnErrors(turn: ConversationTurn): unknown[] {
  return turn.messages.flatMap((message) => message.error ? [message.error] : []);
}
