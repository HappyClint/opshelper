import assert from "node:assert/strict";
import test from "node:test";

import { resolveConversationSurface } from "./conversation-surface";

test("switching conversations stays loading until the matching snapshot arrives", () => {
  assert.equal(resolveConversationSurface("conversation-2", "conversation-1", null), "loading");
  assert.equal(resolveConversationSurface("conversation-2", null, null), "loading");
  assert.equal(resolveConversationSurface("conversation-2", "conversation-2", null), "ready");
});

test("only a route without a conversation renders the new conversation surface", () => {
  assert.equal(resolveConversationSurface(null, "conversation-1", null), "new");
});

test("a failed snapshot is not presented as a new conversation", () => {
  assert.equal(resolveConversationSurface("conversation-2", null, "conversation-2"), "unavailable");
});
