import assert from "node:assert/strict";
import test from "node:test";
import { normalizeV2Messages, normalizeV2Event, normalizeV2Form, v2FormAnswer, v2List } from "./opencode-v2";
import { currentExecutionMessages, isFinalAssistant } from "./execution-observation";
import { ConversationTextProjector } from "./conversation-events";

test("V2 execution finishes only at persisted idle and never borrows the previous turn", () => {
  const values = [
    { id: "u1", type: "user", text: "marker1", time: { created: 1 } },
    { id: "a1", type: "assistant", content: [{ type: "text", text: "answer" }], finish: "stop", time: { created: 2, completed: 3 } },
  ];
  assert.equal(isFinalAssistant(normalizeV2Messages(values, "s")[1]), false);
  const finished = normalizeV2Messages([...values, { id: "i1", type: "idle", outcome: "succeeded", time: { created: 4 } },
    { id: "u2", type: "user", text: "marker2", time: { created: 5 } }], "s");
  assert.equal(isFinalAssistant(finished[1]), true);
  assert.equal(currentExecutionMessages(finished, "marker2").length, 0);
  const failed = normalizeV2Messages([values[0], { id: "i2", type: "idle", outcome: "failed", error: { message: "provider failed" }, time: { created: 4 } }], "s");
  assert.equal(failed[1].info.error.message, "provider failed");
});

test("V2 SSE keeps session boundaries and projects only assistant text", () => {
  const projector = new ConversationTextProjector("s", [], 10);
  const event = (type: string, data: Record<string, unknown>, created = 11) => normalizeV2Event({ type, data: { sessionID: "s", assistantMessageID: "a", ...data }, created });
  projector.apply(event("session.step.started", {}));
  projector.apply(event("session.text.started", { ordinal: 0 }));
  assert.equal(projector.apply(event("session.text.delta", { ordinal: 0, delta: "你好" }))[0].text, "你好");
  assert.deepEqual(projector.apply(event("session.reasoning.delta", { ordinal: 1, delta: "private" })), []);
  assert.deepEqual(projector.apply(event("session.text.delta", { sessionID: "foreign", ordinal: 0, delta: "secret" })), []);
  assert.equal(projector.apply(event("session.text.ended", { ordinal: 0, text: "你好世界" }))[0].text, "你好世界");
});

test("V2 form replies use field keys and option values, with typed numbers and booleans", () => {
  const form = { title: "确认", fields: [
    { key: "choice", title: "选项", description: "是否继续执行？", type: "string", options: [{ label: "继续", value: "yes" }] },
    { key: "count", type: "integer" }, { key: "enabled", type: "boolean" },
    { key: "hidden", type: "string", hidden: true },
  ] };
  assert.equal(normalizeV2Form(form).questions.length, 3);
  assert.equal(normalizeV2Form(form).questions[0].header, "选项");
  assert.equal(normalizeV2Form(form).questions[0].question, "是否继续执行？");
  assert.deepEqual(v2FormAnswer(form, [["继续"], ["2"], ["否"]]), { choice: "yes", count: 2, enabled: false });
  assert.throws(() => v2FormAnswer(form, [["继续"], ["bad"], ["否"]]), /数字/);
});

test("reasoning and tools do not change text identities between V2 snapshots and SSE", () => {
  const messages = normalizeV2Messages([{ id: "a", type: "assistant", time: { created: 1, completed: 2 }, content: [
    { type: "reasoning", text: "private" }, { type: "text", text: "first" },
    { id: "tool", type: "tool", name: "read", state: { status: "error", error: { message: "File not found" } } },
    { type: "text", text: "second" },
  ] }], "s");
  const projector = new ConversationTextProjector("s", [], 0);
  const seeded = projector.seed(messages);
  assert.deepEqual(seeded.map((part) => part.partId), ["a:text:0", "a:text:1"]);
  for (const [ordinal, text] of ["first", "second"].entries()) {
    assert.deepEqual(projector.apply(normalizeV2Event({ type: "session.text.ended", created: 2,
      data: { sessionID: "s", assistantMessageID: "a", ordinal, text } })), []);
  }
  const tool = messages[0].parts.find((part: any) => part.type === "tool");
  assert.equal(tool.state.output, undefined);
  assert.equal(tool.state.error, "File not found");
});

test("V2 pagination follows cursors until empty without duplicating records", async () => {
  const original = globalThis.fetch;
  const routes: string[] = [];
  const pages = [
    { data: [{ id: "1" }, { id: "2" }], cursor: { next: "p2" } },
    { data: [{ id: "2" }, { id: "3" }], cursor: { next: "p3" } },
    { data: [], cursor: {} },
  ];
  globalThis.fetch = async (input) => { routes.push(String(input)); return Response.json(pages.shift()); };
  try {
    assert.deepEqual((await v2List({ target: "http://runtime", authorization: "test" }, "/api/session")).map((value) => value.id), ["1", "2", "3"]);
    assert.match(routes[1], /cursor=p2/);
    assert.doesNotMatch(routes[1], /order=/);
  } finally { globalThis.fetch = original; }
});
