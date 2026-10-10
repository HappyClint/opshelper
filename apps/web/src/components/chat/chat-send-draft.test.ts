import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { conversationDraftKey, EMPTY_DRAFT, moveConversationDraft, updateConversationDraft, parseConversationDrafts, serializeConversationDrafts, type ConversationDrafts } from "./conversation-drafts";
import type { Attachment } from "./types";

const source = ts.createSourceFile("chat-app.tsx", readFileSync(new URL("./chat-app.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
let initializer: string | undefined;
let recoveryInitializer: string | undefined;
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "send") initializer = node.initializer?.getText(source);
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === "restoreFailedDraft") recoveryInitializer = node.initializer?.getText(source);
  ts.forEachChild(node, visit);
}
visit(source);
assert.ok(initializer);
const callback = ts.transpileModule(`globalThis.send = ${initializer};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function chat(
  conversationId: string | null,
  createConversation: () => Promise<{ conversationId: string }>,
  createExecution: () => Promise<unknown>,
  navigating = false,
  attachments: Attachment[] = [],
) {
  const key = conversationDraftKey(conversationId, "ops");
  const state = {
    drafts: {
      [key]: { input: "original message", attachments },
      "conversation:b": { input: "B draft", attachments: [] },
    } as ConversationDrafts,
    activated: [] as string[],
    urls: [] as string[],
    refreshes: [] as unknown[],
    notice: null as string | null,
    toast: null as string | null,
  };
  const activeConversationRef = { current: conversationId };
  const conversationGenerationRef = { current: 0 };
  const updateDraft = (key: string, update: Parameters<typeof updateConversationDraft>[2]) => {
    state.drafts = updateConversationDraft(state.drafts, key, update);
  };
  let clientSequence = 0;
  const noop = () => {};
  const context = vm.createContext({
    Error,
    useCallback: (fn: unknown) => fn,
    activeAssistant: { id: "ops" }, input: "original message", readyAttachments: attachments, attachments, draftsReady: true, navigating,
    drafts: state.drafts, draftKey: key, conversationDraftKey, activeConversationRef, conversationGenerationRef,
    sendingRef: { current: false }, forkingRef: { current: false }, pendingRequestRef: { current: null },
    optimisticMessagesRef: { current: [] }, currentMessages: [],
    updateOptimisticMessages: (update: (items: unknown[]) => unknown[]) => update([]),
    createClientId: () => `client-${++clientSequence}`, optimisticMessage: () => ({}), messageSignature: () => "signature", nextExpectedMatchCount: () => 1,
    setInput: (input: string) => updateDraft(key, (draft) => ({ ...draft, input })),
    setAttachments: (attachments: []) => updateDraft(key, (draft) => ({ ...draft, attachments })),
    updateDraft,
    setDraft: (key: string, draft: ConversationDrafts[string]) => updateDraft(key, () => draft),
    moveDraft: (from: string, to: string) => { state.drafts = moveConversationDraft(state.drafts, from, to); },
    setSending: noop, setNotice: (value: string | null) => { state.notice = value; },
    createConversation, createExecution, model: "", autoApprovePermissions: false,
    activateConversation: (id: string) => { state.activated.push(id); },
    router: { replace: (url: string) => { state.urls.push(url); } },
    requestSignature: () => "request", waitForStreamReady: async () => {},
    refreshHome: async (id: string, options: unknown) => { state.refreshes.push({ id, options }); },
    refreshConversation: async () => {}, toast: { error: (value: string) => { state.toast = value; } },
  });
  vm.runInContext(callback, context);
  assert.ok(recoveryInitializer);
  vm.runInContext(ts.transpileModule(`globalThis.restoreFailedDraft = ${recoveryInitializer};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return {
    state, updateDraft,
    restore: (recoveryKey: string) => {
      context.drafts = state.drafts;
      context.input = state.drafts[key]?.input ?? "";
      context.attachments = state.drafts[key]?.attachments ?? [];
      context.restoreFailedDraft(recoveryKey);
    },
    send: context.send as () => Promise<void>,
    navigate: (id: string | null) => { activeConversationRef.current = id; conversationGenerationRef.current += 1; },
  };
}

test("a late failed send restores only the original conversation's draft", async () => {
  const execution = deferred<unknown>();
  const input = chat("a", async () => ({ conversationId: "created" }), () => execution.promise);
  const sending = input.send();
  input.navigate("b");
  execution.reject(new Error("offline"));
  await sending;
  assert.equal(input.state.drafts["conversation:a"].input, "original message");
  assert.equal(input.state.drafts["conversation:b"].input, "B draft");
  assert.equal(input.state.notice, null);
  assert.match(input.state.toast ?? "", /offline/);
});

test("a successful first send transfers newer blank input to the created conversation", async () => {
  const creation = deferred<{ conversationId: string }>();
  const input = chat(null, () => creation.promise, async () => ({}));
  const sending = input.send();
  input.updateDraft("new:ops", () => ({ input: "next message", attachments: [] }));
  creation.resolve({ conversationId: "created" });
  await sending;
  assert.equal(input.state.drafts["new:ops"], undefined);
  assert.equal(input.state.drafts["conversation:created"].input, "next message");
  assert.deepEqual(input.state.activated, ["created"]);
  assert.deepEqual(JSON.parse(JSON.stringify(input.state.refreshes)), [{ id: "created", options: { activate: false } }]);
});

test("late conversation creation does not replace a newly selected conversation or its draft", async () => {
  const creation = deferred<{ conversationId: string }>();
  const input = chat(null, () => creation.promise, async () => ({}));
  const sending = input.send();
  input.navigate("b");
  creation.resolve({ conversationId: "created" });
  await sending;
  assert.deepEqual(input.state.activated, []);
  assert.deepEqual(input.state.urls, []);
  assert.equal(input.state.drafts["conversation:b"].input, "B draft");
});

test("first-send failure after creation restores the draft under the created id, not the blank scope", async () => {
  const input = chat(null, async () => ({ conversationId: "created" }), async () => { throw new Error("offline"); });
  await input.send();
  assert.equal(input.state.drafts["new:ops"], undefined);
  assert.equal(input.state.drafts["conversation:created"].input, "original message");
  assert.match(input.state.notice ?? "", /offline/);
});

test("clearing a sent draft does not clear another conversation's draft", async () => {
  const input = chat("a", async () => ({ conversationId: "created" }), async () => ({}));
  await input.send();
  assert.deepEqual(input.state.drafts["conversation:a"] ?? EMPTY_DRAFT, EMPTY_DRAFT);
  assert.equal(input.state.drafts["conversation:b"].input, "B draft");
});

test("sending is blocked until the route and active conversation agree", async () => {
  let submitted = false;
  const input = chat("a", async () => ({ conversationId: "created" }), async () => { submitted = true; }, true);
  await input.send();
  assert.equal(submitted, false);
  assert.equal(input.state.drafts["conversation:a"].input, "original message");
});

for (const failExecution of [false, true]) {
  test(`reopening the same agent's blank view preserves its text and attachments when the earlier creation completes${failExecution ? " and execution fails" : ""}`, async () => {
    const creation = deferred<{ conversationId: string }>();
    const oldFile: Attachment = {
      id: "old-file", path: "/workspace/old.txt", filename: "old.txt", mime: "text/plain", status: "ready", source: "mention",
    };
    const newFile: Attachment = { ...oldFile, id: "new-file", path: "/workspace/new.txt", filename: "new.txt" };
    const input = chat(null, () => creation.promise, async () => {
      if (failExecution) throw new Error("offline");
      return {};
    }, false, [oldFile]);
    const sending = input.send();
    input.navigate(null); // A fresh blank view has the same id/key, but a different generation.
    input.updateDraft("new:ops", () => ({ input: "new blank draft", attachments: [newFile] }));
    creation.resolve({ conversationId: "created" });
    await sending;
    assert.equal(input.state.drafts["new:ops"]?.input, "new blank draft");
    assert.equal(input.state.drafts["new:ops"]?.attachments[0]?.path, "/workspace/new.txt");
    assert.deepEqual(input.state.activated, []);
    assert.deepEqual(input.state.urls, []);
    if (failExecution) {
      assert.equal(input.state.drafts["conversation:created"].input, "original message");
      assert.equal(input.state.drafts["conversation:created"].attachments[0].path, "/workspace/old.txt");
    } else {
      assert.equal(input.state.drafts["conversation:created"], undefined);
    }
  });
}

for (const destination of ["same blank", "another conversation", "unchanged blank"] as const) {
  test(`creation rejection preserves the submitted snapshot separately in ${destination}`, async () => {
    const creation = deferred<{ conversationId: string }>();
    const oldFile: Attachment = {
      id: "old-file", path: "/workspace/old.txt", filename: "old.txt", mime: "text/plain", status: "ready", source: "upload",
    };
    const newFile: Attachment = { ...oldFile, id: "new-file", path: "/workspace/new.txt", filename: "new.txt" };
    let executed = false;
    const input = chat(null, () => creation.promise, async () => { executed = true; }, false, [oldFile]);
    const sending = input.send();
    if (destination === "same blank") {
      input.navigate(null);
      input.updateDraft("new:ops", () => ({ input: "new blank draft", attachments: [newFile] }));
    } else if (destination === "another conversation") {
      input.navigate("b");
    }
    creation.reject(new Error("creation offline"));
    await sending;
    assert.equal(executed, false);
    assert.deepEqual(input.state.activated, []);
    assert.deepEqual(input.state.urls, []);
    assert.equal(input.state.drafts["conversation:b"].input, "B draft");
    const recovered = input.state.drafts["new:ops:failed:client-1"];
    assert.equal(recovered.input, "original message");
    assert.equal(recovered.attachments[0].path, "/workspace/old.txt");
    if (destination === "same blank") {
      assert.equal(input.state.drafts["new:ops"].input, "new blank draft");
      assert.equal(input.state.drafts["new:ops"].attachments[0].path, "/workspace/new.txt");
    }
    const persisted = parseConversationDrafts(serializeConversationDrafts(input.state.drafts));
    assert.deepEqual(persisted["new:ops:failed:client-1"], JSON.parse(JSON.stringify(recovered)));
    assert.match(input.state.notice ?? input.state.toast ?? "", /未发送草稿已单独保留/);
    if (destination !== "another conversation") {
      input.restore("new:ops:failed:client-1");
      assert.equal(input.state.drafts["new:ops"].input, "original message");
      assert.equal(input.state.drafts["new:ops"].attachments[0].path, "/workspace/old.txt");
      if (destination === "same blank") {
        assert.equal(input.state.drafts["new:ops:failed:client-1"].input, "new blank draft");
        assert.equal(input.state.drafts["new:ops:failed:client-1"].attachments[0].path, "/workspace/new.txt");
        input.restore("new:ops:failed:client-1");
        assert.equal(input.state.drafts["new:ops"].input, "new blank draft");
        assert.equal(input.state.drafts["new:ops:failed:client-1"].input, "original message");
      } else {
        assert.equal(input.state.drafts["new:ops:failed:client-1"], undefined);
      }
    }
  });
}

for (const blockedBy of ["sending", "forking", "navigation", "draft loading"] as const) {
  test(`new uploads are rejected during ${blockedBy}, including the attachment panel`, () => {
    let initializer: string | undefined;
    function visit(node: ts.Node) {
      if (ts.isVariableDeclaration(node) && node.name.getText(source) === "addFiles") initializer = node.initializer?.getText(source);
      ts.forEachChild(node, visit);
    }
    visit(source);
    assert.ok(initializer);
    let added = false;
    const context = vm.createContext({
      useCallback: (fn: unknown) => fn,
      sendingRef: { current: blockedBy === "sending" },
      forkingRef: { current: blockedBy === "forking" },
      navigating: blockedBy === "navigation", draftsReady: blockedBy !== "draft loading",
      setAttachments: () => { added = true; },
      createClientId: () => "upload", guessMime: () => "text/plain",
      uploadFile: async () => ({ path: "/workspace/file.txt" }), CHAT_UPLOAD_DIR: "/workspace/.uploads",
    });
    vm.runInContext(ts.transpileModule(`globalThis.addFiles = ${initializer};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
    context.addFiles([{ name: "file.txt", type: "text/plain" }]);
    assert.equal(added, false);
  });
}
