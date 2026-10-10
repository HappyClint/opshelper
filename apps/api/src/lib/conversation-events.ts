export interface ConversationTextEvent {
  messageId: string;
  partId: string;
  text: string;
}

function record(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, any>
    : {};
}

/** Read SSE frames even when UTF-8 characters or frame delimiters span chunks. */
export async function* readRuntimeEvents(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 4 * 1024 * 1024) throw new Error("运行环境事件过大");
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart()).join("\n");
        if (!data) continue;
        try {
          yield record(JSON.parse(data));
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Hold a possible internal identifier until enough text arrives to redact it. */
export function safeStreamText(text: string, executionIds: string[], complete: boolean) {
  const paths = executionIds.flatMap((id) => [`/workspace/outputs/${id}`, `outputs/${id}`]);
  let result = text.replace(/\n?\n?<!-- opshelper-execution:[A-Za-z0-9-]+ -->/g, "");
  for (const path of paths) result = result.replaceAll(path, "结果文件");
  const markerPrefix = "<!-- opshelper-execution:";
  const markerStart = result.lastIndexOf(markerPrefix);
  if (markerStart >= 0 && !result.slice(markerStart).includes("-->")) {
    result = result.slice(0, markerStart);
  }
  if (complete) return result.trimEnd();
  let held = 0;
  for (const prefix of [...paths, markerPrefix]) {
    for (let length = 1; length < prefix.length && length <= result.length; length++) {
      if (result.endsWith(prefix.slice(0, length))) held = Math.max(held, length);
    }
  }
  return held ? result.slice(0, -held) : result;
}

interface TextPart {
  type?: string;
  text: string;
  pending: string;
  anchored: boolean;
  complete: boolean;
}

/** Only assistant text from the owned root session can cross this boundary. */
export class ConversationTextProjector {
  private roles = new Map<string, string>();
  private parts = new Map<string, Map<string, TextPart>>();
  private sent = new Map<string, string>();
  private seenEvents = new Set<string>();

  constructor(
    readonly sessionId: string,
    private executionIds: string[],
    private connectedAt: number,
  ) {}

  setExecutionIds(ids: string[]) {
    this.executionIds = ids;
  }

  hasMessage(id: string) {
    return this.roles.has(id);
  }

  seed(messages: unknown[]) {
    for (const value of messages) {
      const message = record(value);
      const info = record(message.info);
      if (typeof info.id !== "string" || info.sessionID !== this.sessionId) continue;
      this.roles.set(info.id, info.role);
      for (const raw of Array.isArray(message.parts) ? message.parts : []) {
        const part = record(raw);
        if (typeof part.id !== "string" || part.type !== "text") continue;
        const complete = typeof part.time?.end === "number" || typeof info.time?.completed === "number";
        this.messageParts(info.id).set(part.id, {
          type: part.type,
          text: typeof part.text === "string" ? part.text : "",
          pending: "",
          // A reconnect cannot reconstruct deltas emitted before subscription.
          // Wait for the authoritative full part instead of displaying a suffix.
          anchored: complete || (part.text === "" && part.time?.start >= this.connectedAt),
          complete,
        });
      }
    }
    return this.textEvents();
  }

  accepts(value: unknown) {
    const event = record(value);
    const properties = record(event.properties);
    return (properties.sessionID ?? properties.info?.sessionID ?? properties.part?.sessionID ??
      properties.info?.id) === this.sessionId;
  }

  apply(value: unknown): ConversationTextEvent[] {
    const event = record(value);
    if (!this.accepts(event)) return [];
    if (typeof event.id === "string") {
      if (this.seenEvents.has(event.id)) return [];
      this.seenEvents.add(event.id);
      if (this.seenEvents.size > 4096) this.seenEvents.delete(this.seenEvents.values().next().value!);
    }
    const properties = record(event.properties);
    if (event.type === "message.updated") {
      const info = record(properties.info);
      if (typeof info.id !== "string") return [];
      this.roles.set(info.id, info.role);
      return this.textEvents(info.id);
    }
    if (event.type === "message.part.updated") {
      const part = record(properties.part);
      if (typeof part.messageID !== "string" || typeof part.id !== "string") return [];
      const parts = this.messageParts(part.messageID);
      const previous = parts.get(part.id);
      const complete = typeof part.time?.end === "number";
      if (previous?.complete && !complete) return [];
      const text = typeof part.text === "string" ? part.text : "";
      const anchored = complete || part.time?.start >= this.connectedAt || previous?.anchored === true;
      parts.set(part.id, {
        type: part.type,
        text: text === "" && !complete ? previous?.text || previous?.pending || "" : text,
        pending: "",
        anchored,
        complete,
      });
      return this.textEvents(part.messageID);
    }
    if (event.type === "message.part.delta") {
      if (properties.field !== "text" || typeof properties.delta !== "string" ||
        typeof properties.messageID !== "string" || typeof properties.partID !== "string") return [];
      const parts = this.messageParts(properties.messageID);
      const part = parts.get(properties.partID) ?? { text: "", pending: "", anchored: false, complete: false };
      if (part.complete) return [];
      if (part.type === undefined) part.pending += properties.delta;
      else if (part.type === "text" && part.anchored) part.text += properties.delta;
      if (part.pending.length > 4 * 1024 * 1024 || part.text.length > 4 * 1024 * 1024) {
        throw new Error("运行环境正文过大");
      }
      parts.set(properties.partID, part);
      return this.textEvents(properties.messageID);
    }
    return [];
  }

  private messageParts(id: string) {
    let parts = this.parts.get(id);
    if (!parts) {
      parts = new Map();
      this.parts.set(id, parts);
    }
    return parts;
  }

  private textEvents(onlyMessageId?: string) {
    const events: ConversationTextEvent[] = [];
    for (const [messageId, parts] of this.parts) {
      if ((onlyMessageId && onlyMessageId !== messageId) || this.roles.get(messageId) !== "assistant") continue;
      for (const [partId, part] of parts) {
        if (part.type !== "text" || !part.anchored) continue;
        const text = safeStreamText(part.text, this.executionIds, part.complete);
        const key = `${messageId}:${partId}`;
        if (this.sent.get(key) === text) continue;
        this.sent.set(key, text);
        if (text || part.complete) events.push({ messageId, partId, text });
      }
    }
    return events;
  }
}

export function conversationEventFrame(event: "text" | "ready" | "changed", data: unknown = {}) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
