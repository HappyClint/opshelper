import assert from "node:assert/strict";
import test from "node:test";

import {
  conversationDraftKey,
  conversationDraftStorageKey,
  EMPTY_DRAFT,
  hasDraft,
  moveConversationDraft,
  parseConversationDrafts,
  serializeConversationDrafts,
  updateConversationDraft,
} from "./conversation-drafts";
import type { Attachment } from "./types";

const attachment: Attachment = {
  id: "file-1", path: "/workspace/test.txt", filename: "test.txt", mime: "text/plain", status: "ready", source: "upload",
};

test("conversation and blank drafts are isolated, including blank drafts for different agents", () => {
  const a = conversationDraftKey("a", "ops");
  const b = conversationDraftKey("b", "ops");
  const blank = conversationDraftKey(null, "ops");
  const otherBlank = conversationDraftKey(null, "db");
  let drafts = updateConversationDraft({}, a, () => ({ input: "check a", attachments: [attachment] }));
  drafts = updateConversationDraft(drafts, b, () => ({ input: "check b", attachments: [] }));
  drafts = updateConversationDraft(drafts, blank, () => ({ input: "new task", attachments: [] }));
  assert.equal(drafts[a].input, "check a");
  assert.equal(drafts[b].input, "check b");
  assert.equal(drafts[blank].input, "new task");
  assert.equal(drafts[otherBlank], undefined);
  assert.deepEqual(drafts[a].attachments, [attachment]);
});

test("late upload completion updates its original draft, not another conversation", () => {
  let drafts = updateConversationDraft({}, "conversation:a", () => ({ input: "A", attachments: [{ ...attachment, status: "uploading" }] }));
  drafts = updateConversationDraft(drafts, "conversation:b", () => ({ input: "B", attachments: [] }));
  drafts = updateConversationDraft(drafts, "conversation:a", (draft) => ({
    ...draft, attachments: draft.attachments.map((file) => file.id === attachment.id ? attachment : file),
  }));
  assert.deepEqual(drafts["conversation:a"].attachments, [attachment]);
  assert.deepEqual(drafts["conversation:b"], { input: "B", attachments: [] });
});

test("creating a conversation moves only its blank draft, including text entered while sending", () => {
  const drafts = {
    "new:ops": { input: "next message", attachments: [attachment] },
    "conversation:b": { input: "untouched", attachments: [] },
  };
  const moved = moveConversationDraft(drafts, "new:ops", "conversation:a");
  assert.equal(moved["new:ops"], undefined);
  assert.deepEqual(moved["conversation:a"], drafts["new:ops"]);
  assert.equal(moved["conversation:b"], drafts["conversation:b"]);
  assert.ok(drafts["new:ops"], "original store is not mutated");
});

test("emptying one draft removes its badge without clearing other drafts", () => {
  const drafts = {
    "conversation:a": { input: "A", attachments: [] },
    "conversation:b": { input: "", attachments: [attachment] },
  };
  const next = updateConversationDraft(drafts, "conversation:a", () => EMPTY_DRAFT);
  assert.equal(hasDraft(next["conversation:a"]), false);
  assert.equal(hasDraft(next["conversation:b"]), true);
});

test("reload restores text and ready attachments, not pending or failed uploads", () => {
  const drafts = { "conversation:a": { input: "draft", attachments: [
    attachment,
    { ...attachment, id: "pending", status: "uploading" as const },
    { ...attachment, id: "failed", status: "error" as const },
  ] } };
  assert.deepEqual(parseConversationDrafts(serializeConversationDrafts(drafts)), {
    "conversation:a": { input: "draft", attachments: [attachment] },
  });
});

test("corrupt storage and malformed attachment entries cannot crash draft restoration", () => {
  for (const raw of [null, "{broken", "null", "[]", "3"]) assert.deepEqual(parseConversationDrafts(raw), {});
  assert.deepEqual(parseConversationDrafts(JSON.stringify({
    bad: { input: "ignored" },
    "conversation:a": { input: 12, attachments: [null, {}, { ...attachment, path: "/tmp/test.txt" }] },
    "new:ops": { input: "kept", attachments: [attachment, null] },
  })), { "new:ops": { input: "kept", attachments: [attachment] } });
});

test("draft persistence is scoped to the signed-in account", () => {
  assert.notEqual(conversationDraftStorageKey("alice"), conversationDraftStorageKey("bob"));
});
