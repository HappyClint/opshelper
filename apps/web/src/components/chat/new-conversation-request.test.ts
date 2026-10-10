import assert from "node:assert/strict";
import test from "node:test";

import { resolveNewConversationRequest } from "./new-conversation-request";

test("a pending request initializes a blank conversation once", () => {
  assert.equal(resolveNewConversationRequest({ id: 1, prefill: "检查磁盘" }, null), "apply");
  assert.equal(resolveNewConversationRequest(null, null), "ignore");
});

test("a stale request cannot clear a selected conversation after the chat page remounts", () => {
  assert.equal(
    resolveNewConversationRequest({ id: 1, prefill: "" }, "conversation-2"),
    "discard",
  );
});
