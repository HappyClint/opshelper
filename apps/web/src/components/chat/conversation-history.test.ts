import assert from "node:assert/strict";
import test from "node:test";

import { RECENT_CONVERSATION_LIMIT, resolveConversationHistory } from "./conversation-history";

const conversations = Array.from(
  { length: RECENT_CONVERSATION_LIMIT + 5 },
  (_, index) => ({ id: `conversation-${index + 1}` }),
);

test("sidebar lists recent conversations and counts the folded ones", () => {
  const window = resolveConversationHistory(conversations, {
    activeConversationId: "conversation-1",
    searchTerm: "",
    showAll: false,
  });

  assert.equal(window.listed.length, RECENT_CONVERSATION_LIMIT);
  assert.equal(window.listed[0].id, "conversation-1");
  assert.equal(window.earlierCount, 5);
  assert.equal(window.expandable, true);
  assert.equal(window.expanded, false);
});

test("expanding shows older conversations and offers to collapse again", () => {
  const window = resolveConversationHistory(conversations, {
    activeConversationId: "conversation-1",
    searchTerm: "",
    showAll: true,
  });

  assert.equal(window.listed.length, conversations.length);
  assert.equal(window.expandable, true);
  assert.equal(window.expanded, true);
});

test("a short list never folds", () => {
  const window = resolveConversationHistory(conversations.slice(0, 3), {
    activeConversationId: null,
    searchTerm: "",
    showAll: false,
  });

  assert.equal(window.listed.length, 3);
  assert.equal(window.earlierCount, 0);
  assert.equal(window.expandable, false);
});

test("a search term lists every match instead of folding", () => {
  const window = resolveConversationHistory(conversations, {
    activeConversationId: "conversation-1",
    searchTerm: "验收",
    showAll: false,
  });

  assert.equal(window.listed.length, conversations.length);
  assert.equal(window.expandable, false);
  assert.equal(window.expanded, false);
});

test("an active conversation beyond the fold stays visible", () => {
  const window = resolveConversationHistory(conversations, {
    activeConversationId: "conversation-14",
    searchTerm: "",
    showAll: false,
  });

  assert.equal(window.listed.length, conversations.length);
  assert.equal(window.expandable, false);
  assert.ok(window.listed.some((item) => item.id === "conversation-14"));
});

test("the last recent conversation may still be folded with the rest", () => {
  const window = resolveConversationHistory(conversations, {
    activeConversationId: `conversation-${RECENT_CONVERSATION_LIMIT}`,
    searchTerm: "",
    showAll: false,
  });

  assert.equal(window.listed.length, RECENT_CONVERSATION_LIMIT);
  assert.equal(window.expandable, true);
});
