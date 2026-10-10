import assert from "node:assert/strict";
import test from "node:test";

import {
  createConversationStreamState,
  mergeStreamMessages,
  receiveStreamText,
  settleStreamSnapshot,
} from "./conversation-stream";
import type { ChatMessage } from "./message-model";

function assistant(text: string, completed = false): ChatMessage {
  return {
    id: "message-1",
    role: "assistant",
    order: 1,
    parts: [{
      id: "part-1",
      type: "text",
      text,
      raw: { type: "text", text, ...(completed ? { time: { end: 1789488000000 } } : {}) },
    }],
  };
}

const event = { messageId: "message-1", partId: "part-1", text: "完整的流式回复" };

test("older or missing snapshot text cannot roll back streamed text", () => {
  const state = receiveStreamText(createConversationStreamState("a"), "a", event);
  const old = [assistant("完整")];
  assert.equal(mergeStreamMessages(old, state, "a")[0].parts[0].text, event.text);
  assert.equal(old[0].parts[0].text, "完整");
  assert.equal(mergeStreamMessages([], state, "a")[0].parts[0].text, event.text);
  const newer = [assistant(`${event.text}。`)];
  assert.equal(mergeStreamMessages(newer, state, "a")[0].parts[0].text, `${event.text}。`);
});

test("cumulative events are idempotent and reconnect seeds cannot shrink text", () => {
  const state = receiveStreamText(createConversationStreamState("a"), "a", event);
  assert.equal(receiveStreamText(state, "a", event), state);
  assert.equal(receiveStreamText(state, "a", { ...event, text: "完整" }), state);
  const extended = receiveStreamText(state, "a", { ...event, text: `${event.text}。` });
  assert.equal(extended.parts.size, 1);
  assert.equal(extended.revision, 2);
  assert.equal(mergeStreamMessages([], extended, "a")[0].parts[0].text, `${event.text}。`);
});

test("events and overlays stay within their selected conversation", () => {
  const state = receiveStreamText(createConversationStreamState("a"), "a", event);
  assert.equal(receiveStreamText(state, "b", { ...event, text: "其他会话" }), state);
  const messages = [assistant("其他会话")];
  assert.equal(mergeStreamMessages(messages, state, "b"), messages);
  const reset = createConversationStreamState("b");
  assert.equal(reset.parts.size, 0);
  assert.equal(receiveStreamText(reset, "a", event), reset);
});

test("final snapshots settle only text present in a fresh authoritative response", () => {
  const state = receiveStreamText(createConversationStreamState("a"), "a", event);
  assert.equal(settleStreamSnapshot(state, "a", [assistant(event.text)], 1, false), state);
  assert.equal(settleStreamSnapshot(state, "a", [assistant(event.text)], 0, true), state);
  assert.equal(settleStreamSnapshot(state, "a", [], 1, true), state);
  assert.equal(settleStreamSnapshot(state, "a", [assistant("完整")], 1, true), state);
  assert.equal(settleStreamSnapshot(state, "a", [assistant(event.text)], 1, true).parts.size, 0);
  const corrected = [assistant("最终修订后的正文", true)];
  const settled = settleStreamSnapshot(state, "a", corrected, 1, true);
  assert.equal(settled.parts.size, 0);
  assert.equal(mergeStreamMessages(corrected, settled, "a"), corrected);
});

test("completed terminal parts can trim whitespace or shorten the authoritative reply", () => {
  const state = receiveStreamText(createConversationStreamState("a"), "a", {
    ...event,
    text: "已完成\n",
  });
  const trimmed = [assistant("已完成", true)];
  const settled = settleStreamSnapshot(state, "a", trimmed, state.revision, true);
  assert.equal(settled.parts.size, 0);
  assert.equal(mergeStreamMessages(trimmed, settled, "a")[0].parts[0].text, "已完成");
  assert.equal(settleStreamSnapshot(state, "a", [assistant("已", true)], 1, true).parts.size, 0);
  assert.equal(settleStreamSnapshot(state, "a", [assistant("", true)], 1, true).parts.size, 0);
});

test("unfinished, missing, or older snapshots cannot apply shorter final revisions", () => {
  const state = receiveStreamText(createConversationStreamState("a"), "a", event);
  assert.equal(settleStreamSnapshot(state, "a", [assistant("完整")], 1, true), state);
  assert.equal(settleStreamSnapshot(state, "a", [assistant("暂存修订")], 1, true), state);
  assert.equal(settleStreamSnapshot(state, "a", [], 1, true), state);
  assert.equal(settleStreamSnapshot(state, "a", [assistant("完整", true)], 0, true), state);
  assert.equal(settleStreamSnapshot(state, "a", [assistant("完整", true)], 1, false), state);
});

test("new streamed replies follow optimistic user messages and preserve other parts", () => {
  let state = receiveStreamText(createConversationStreamState("a"), "a", event);
  state = receiveStreamText(state, "a", { ...event, partId: "part-2", text: "第二段" });
  const user: ChatMessage = { id: "optimistic-user", role: "user", order: 2, parts: [] };
  const result = mergeStreamMessages([user], state, "a");
  assert.deepEqual(result.map((message) => message.role), ["user", "assistant"]);
  assert.deepEqual(result[1].parts.map((part) => part.text), [event.text, "第二段"]);
});
