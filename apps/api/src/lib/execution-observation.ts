interface RuntimeMessage {
  info?: Record<string, unknown>;
  parts?: unknown[];
}

function messageRecord(message: unknown): RuntimeMessage | null {
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  return message as RuntimeMessage;
}

function messageText(message: unknown) {
  const parts = messageRecord(message)?.parts;
  if (!Array.isArray(parts)) return "";
  return parts.flatMap((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return [];
    const text = (part as { text?: unknown }).text;
    return typeof text === "string" ? [text] : [];
  }).join("\n");
}

function messageInfo(message: unknown) {
  return messageRecord(message)?.info ?? null;
}

/**
 * Returns only root assistant messages that belong to the user message carrying
 * this execution marker. OpenCode associates every assistant step in one turn
 * with that user message through info.parentID.
 */
export function currentExecutionMessages(rootMessages: unknown[], markerText: string) {
  if (!markerText) return [];
  let markerIndex = -1;
  let markerMessageId: string | null = null;

  for (let index = 0; index < rootMessages.length; index += 1) {
    const info = messageInfo(rootMessages[index]);
    if (info?.role !== "user" || !messageText(rootMessages[index]).includes(markerText)) continue;
    if (typeof info.id !== "string" || !info.id) continue;
    markerIndex = index;
    markerMessageId = info.id;
    break;
  }

  if (markerIndex < 0 || !markerMessageId) return [];
  return rootMessages.slice(markerIndex + 1).filter((message) => {
    const info = messageInfo(message);
    return info?.role === "assistant" && info.parentID === markerMessageId;
  });
}

export function latestCurrentAssistant(rootMessages: unknown[], markerText: string) {
  return currentExecutionMessages(rootMessages, markerText).at(-1) ?? null;
}

export function assistantError(message: unknown) {
  const info = messageInfo(message);
  return info?.role === "assistant" ? info.error ?? null : null;
}

/**
 * An explicit assistant error is terminal. A successful assistant step is only
 * terminal when OpenCode persisted both its completion time and finish reason;
 * tool-calls is an intermediate agent-loop step and must not finish an execution.
 */
export function isFinalAssistant(message: unknown) {
  const info = messageInfo(message);
  if (info?.role !== "assistant") return false;
  if (info.error != null) return true;

  const time = info.time;
  const completed = time && typeof time === "object" && !Array.isArray(time)
    ? (time as { completed?: unknown }).completed
    : undefined;
  return typeof completed === "number" && Number.isFinite(completed) &&
    typeof info.finish === "string" && info.finish.length > 0 && info.finish !== "tool-calls";
}
