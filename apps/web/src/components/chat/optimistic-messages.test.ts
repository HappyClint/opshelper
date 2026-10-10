import assert from "node:assert/strict";
import test from "node:test";

import { messageSignature } from "./format";
import type { ChatMessage } from "./message-model";
import {
  nextExpectedMatchCount,
  pendingOptimisticMessages,
  pruneConfirmedOptimisticMessages,
  type OptimisticMessage,
} from "./optimistic-messages";

function userMessage(id: string, text: string): ChatMessage {
  return {
    id,
    role: "user",
    order: 1,
    parts: [{ id: `${id}-part`, type: "text", text, raw: { type: "text", text } }],
  };
}

function optimistic(id: string, expectedMatchCount: number): OptimisticMessage {
  const message = userMessage(`optimistic-${id}`, "检查服务");
  return {
    clientId: id,
    conversationId: "conversation-1",
    expectedMatchCount,
    signature: messageSignature(message),
    message,
  };
}

test("相同消息连续入队时使用最高期望序号，不受延迟清理影响", () => {
  const first = optimistic("first", 1);
  const confirmed = userMessage("confirmed", "检查服务");

  assert.equal(nextExpectedMatchCount(
    [first],
    "conversation-1",
    first.signature,
    [confirmed],
  ), 2);
});

test("服务端逐条确认相同消息时只移除已确认的乐观副本", () => {
  const first = optimistic("first", 1);
  const second = optimistic("second", 2);
  const oneConfirmed = [userMessage("confirmed-1", "检查服务")];

  assert.deepEqual(
    pendingOptimisticMessages([first, second], "conversation-1", oneConfirmed)
      .map((item) => item.clientId),
    ["second"],
  );
  assert.deepEqual(
    pruneConfirmedOptimisticMessages([first, second], "conversation-1", oneConfirmed)
      .map((item) => item.clientId),
    ["second"],
  );
});

test("切换会话不会误删其他会话尚未确认的消息", () => {
  const item = optimistic("first", 1);

  assert.deepEqual(
    pruneConfirmedOptimisticMessages([item], "conversation-2", []),
    [item],
  );
});
