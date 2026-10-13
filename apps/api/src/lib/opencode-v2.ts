/** OpenCode 2.0.27 boundary. Only platform-owned normalized data leaves it. */
type Row = Record<string, any>;
const row = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};

export class RuntimeRequestError extends Error {
  constructor(message: string, public readonly statusCode: number) { super(message); }
}

export interface RuntimeEndpoint { target: string; authorization: string }

export async function v2Request<T>(connection: RuntimeEndpoint, method: string, route: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
  const response = await fetch(`${connection.target}${route}`, {
    method,
    headers: { authorization: connection.authorization, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  if (!response.ok) throw new RuntimeRequestError(`OpenCode 2 ${method} ${route} 返回 ${response.status}`, response.status);
  return (text ? JSON.parse(text) : undefined) as T;
}

/** V2 cursors can be present on the last nonempty page. Read until empty. */
export async function v2List(connection: RuntimeEndpoint, route: string): Promise<Row[]> {
  const base = new URL(route, "http://runtime");
  base.searchParams.set("order", "asc");
  base.searchParams.set("limit", "100");
  const seen = new Set<string>();
  const ids = new Set<string>();
  const result: Row[] = [];
  for (;;) {
    const page = await v2Request<Row>(connection, "GET", `${base.pathname}${base.search}`);
    if (!Array.isArray(page.data)) throw new Error("OpenCode 2 分页响应无效");
    for (const item of page.data) {
      if (typeof item.id !== "string") throw new Error("OpenCode 2 记录缺少标识");
      if (!ids.has(item.id)) { ids.add(item.id); result.push(item); }
    }
    const cursor = page.cursor?.next;
    if (!page.data.length || !cursor) return result;
    if (seen.has(cursor)) throw new Error("OpenCode 2 分页游标重复");
    seen.add(cursor);
    base.searchParams.delete("order");
    base.searchParams.set("cursor", cursor);
  }
}

export function normalizeV2Messages(values: Row[], sessionID: string) {
  const result: Row[] = [];
  let parentID: string | undefined;
  for (const value of values) {
    if (value.type === "user") {
      parentID = value.id;
      result.push({ info: { id: value.id, sessionID, role: "user", time: value.time }, parts: [
        { id: `${value.id}:0`, type: "text", text: value.text },
        ...(value.files ?? []).map((file: Row, index: number) => ({ id: `${value.id}:file:${index}`, type: "file", url: file.uri, filename: file.name, mime: file.mime ?? "application/octet-stream" })),
      ] });
    } else if (value.type === "assistant") {
      // V2 SSE ordinals count text blocks only, excluding reasoning and tools.
      let textOrdinal = 0;
      result.push({ info: { id: value.id, sessionID, role: "assistant", parentID, agent: value.agent,
        time: value.time, finish: value.finish, error: value.error, runtimeVersion: 2, terminal: false },
      parts: (value.content ?? []).map((part: Row, index: number) => {
        if (part.type !== "tool") return { id: part.type === "text" ? `${value.id}:text:${textOrdinal++}` : `${value.id}:${index}`, sessionID, messageID: value.id, type: part.type, text: part.text,
          time: { start: value.time.created, ...(value.time.completed ? { end: value.time.completed } : {}) } };
        const state = row(part.state);
        return { id: part.id, sessionID, messageID: value.id, type: "tool", tool: part.name === "subagent" ? "task" : part.name === "shell" ? "bash" : part.name,
          state: { status: state.status, input: part.name === "skill" ? { ...row(state.input), name: state.input?.id } : state.input, metadata: { ...row(state.metadata), sessionId: state.metadata?.sessionID }, output: (state.content ?? []).filter((item: Row) => item.type === "text").map((item: Row) => item.text).join("\n").replace(/ sessionID="[^"]+"/g, "") || undefined,
            error: state.error ? String(state.error.message ?? state.error) : undefined, time: part.time } };
      }) });
    } else if (value.type === "idle" && parentID) {
      // A finished provider step is not a finished V2 execution. Only the
      // persisted idle outcome closes the turn, including background tools.
      let last = result.at(-1);
      if (last?.info.role !== "assistant" || last.info.parentID !== parentID) {
        last = { info: { id: value.id, sessionID, role: "assistant", parentID, runtimeVersion: 2 }, parts: [] };
        result.push(last);
      }
      last.info.terminal = true;
      last.info.time = { ...last.info.time, completed: value.time.created };
      last.info.finish = value.outcome === "succeeded" ? "stop" : "error";
      if (value.outcome !== "succeeded") last.info.error = value.error ?? { message: `Execution ${value.outcome}` };
    }
  }
  return result;
}

export function normalizeV2Event(event: Row): Row {
  const data = row(event.data);
  const common = { id: event.id, properties: { sessionID: data.sessionID } };
  const messageID = data.assistantMessageID;
  if (event.type === "session.step.started") return { ...common, type: "message.updated", properties: {
    info: { id: messageID, sessionID: data.sessionID, role: "assistant" },
  } };
  if (event.type === "session.text.delta") return { ...common, type: "message.part.delta", properties: {
    sessionID: data.sessionID, messageID, partID: `${messageID}:text:${data.ordinal}`, field: "text", delta: data.delta,
  } };
  if (event.type === "session.text.started" || event.type === "session.text.ended") return {
    ...common, type: "message.part.updated", properties: { part: {
      id: `${messageID}:text:${data.ordinal}`, messageID, sessionID: data.sessionID, type: "text", text: data.text ?? "",
      time: event.type.endsWith("ended") ? { end: event.created } : { start: event.created },
    } },
  };
  return { ...common, type: event.type };
}

export function normalizeV2Form(form: Row) {
  return { ...form, questions: form.fields.filter((field: Row) => !field.hidden).map((field: Row) => ({
    header: field.title ?? form.title, question: field.description ?? field.title ?? field.key,
    options: field.type === "boolean" ? [{ label: "是" }, { label: "否" }] : field.options ?? [],
    multiple: field.type === "multiselect", custom: field.options ? Boolean(field.custom) : field.type !== "boolean",
  })) };
}

export function v2FormAnswer(form: Row, answers: string[][]) {
  const fields = form.fields.filter((field: Row) => !field.hidden);
  if (answers.length !== fields.length) throw new Error("表单字段已变化，请刷新后重试");
  return Object.fromEntries(fields.map((field: Row, index: number) => {
    const values = answers[index].map((value) => field.options?.find((option: Row) => option.label === value)?.value ?? value);
    let value: unknown = field.type === "multiselect" ? values : values[0];
    if (field.type === "boolean") value = values[0] === "是";
    if (field.type === "number" || field.type === "integer") {
      value = Number(values[0]);
      if (!values[0]?.trim() || !Number.isFinite(value) || (field.type === "integer" && !Number.isInteger(value))) throw new Error("请输入有效数字");
    }
    if (field.type === "external") throw new Error("此表单需要外部客户端处理");
    return [field.key, value];
  }));
}
