import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import type { ForkConversationResponse } from "@opshelper/shared";

// Exercise the provider's actual callbacks without mounting Next's router.
const source = ts.createSourceFile(
  "workspace-shell.tsx",
  readFileSync(new URL("./workspace-shell.tsx", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const chatSource = ts.createSourceFile(
  "chat-app.tsx",
  readFileSync(new URL("./chat/chat-app.tsx", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);

function callback(name: string, file = source) {
  let initializer: string | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === name) {
      initializer = node.initializer?.getText(file);
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(initializer, `Missing provider callback: ${name}`);
  return ts.transpileModule(`globalThis.${name} = ${initializer};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const fork = { id: "fork", leadAgentKey: "agent-a" };
const other = { id: "other", leadAgentKey: "agent-b" };
const home = {
  agents: [{ key: "agent-a" }, { key: "agent-b" }],
  conversations: [fork, other],
  executionBlockedReason: null,
};

function workspace(
  listConversations: () => Promise<typeof home>,
  getConversation = async (_id: string) => ({ conversation: fork }),
  forkConversation = async (): Promise<ForkConversationResponse> => ({
    conversationId: fork.id,
    leadAgentKey: fork.leadAgentKey,
    text: "fork draft",
    attachments: [],
  }),
  archiveConversation = async (_id: string) => {},
) {
  const state = {
    conversation: "source" as string | null,
    agent: "agent-a" as string | null,
    conversations: [] as typeof home.conversations,
    url: "/chat?conversation=source",
    input: "current draft",
    attachments: [] as unknown[],
    drafts: {} as Record<string, { input: string; attachments: unknown[] }>,
  };
  const noop = () => {};
  const conversationGenerationRef = { current: 0 };
  const forkingRef = { current: false };
  const currentRouteRef = { current: { pathname: "/chat", conversationId: "source" as string | null } };
  const setRoute = (url: string) => {
    state.url = url;
    const route = new URL(url, "https://opshelper.test");
    currentRouteRef.current = { pathname: route.pathname, conversationId: route.searchParams.get("conversation") };
  };
  const context = vm.createContext({
    useCallback: (fn: unknown) => fn,
    listConversations,
    getConversation,
    archiveConversation,
    currentRouteRef,
    forkConversation,
    conversationGenerationRef,
    forkingRef,
    sendingRef: { current: false },
    hasActiveExecution: false,
    pendingRequestRef: { current: null },
    setForkingMessageId: noop,
    setNotice: noop,
    conversationDraftKey: (id: string | null, agent: string) => id ? `conversation:${id}` : `new:${agent}`,
    setDraft: (key: string, draft: { input: string; attachments: unknown[] }) => { state.drafts[key] = draft; },
    createClientId: () => "attachment-id",
    navigationGenerationRef: { current: 0 },
    activeConversationRef: { current: state.conversation },
    activeAgentKeyRef: { current: state.agent },
    setActiveConversationId: (id: string | null) => {
      state.conversation = id;
      const draft = state.drafts[`conversation:${id}`];
      if (draft) {
        state.input = draft.input;
        state.attachments = draft.attachments;
      }
      conversationGenerationRef.current += 1;
    },
    setActiveAgentKey: (key: string | null) => { state.agent = key; },
    setConversations: (items: typeof home.conversations | ((current: typeof home.conversations) => typeof home.conversations)) => {
      state.conversations = typeof items === "function" ? items(state.conversations) : items;
    },
    setAgents: noop,
    setExecutionBlockedReason: noop,
    storedValue: () => null,
    storeValue: noop,
    CHAT_CONTEXT_KEY: "conversation",
    CHAT_AGENT_KEY: "agent",
    setShowSidebar: noop,
    newConversationSequenceRef: { current: 0 },
    setNewConversationRequest: noop,
    router: { push: setRoute, replace: setRoute },
  });
  for (const name of ["setActiveAgent", "activateConversation", "clearActiveConversation", "refreshHome", "startNewConversation", "removeConversation"]) {
    vm.runInContext(callback(name), context);
  }
  vm.runInContext(callback("restartFrom", chatSource), context);
  return {
    state,
    forkingRef,
    setRoute,
    removeConversation: context.removeConversation as (id: string) => Promise<void>,
    refreshHome: context.refreshHome as (id?: string | null, options?: { activate?: boolean }) => Promise<void>,
    restartFrom: context.restartFrom as (message: { id: string }) => Promise<void>,
    activateConversation: context.activateConversation as (id: string, agent: string) => void,
    startNewConversation: context.startNewConversation as () => void,
    setActiveAgent: context.setActiveAgent as (key: string) => void,
  };
}

test("home refresh activates the requested fork when navigation has not changed", async () => {
  const provider = workspace(async () => home);
  await provider.refreshHome("fork");
  assert.equal(provider.state.conversation, "fork");
  assert.equal(provider.state.agent, "agent-a");
});

test("a delayed fork list refresh preserves a newly opened blank conversation", async () => {
  const list = deferred<typeof home>();
  const provider = workspace(() => list.promise);
  const refresh = provider.refreshHome("fork");
  provider.startNewConversation();
  list.resolve(home);
  await refresh;
  assert.equal(provider.state.conversation, null);
  assert.match(provider.state.url, /^\/chat\?new=/);
  assert.equal(provider.state.conversations, home.conversations);
});

test("a delayed fork list refresh preserves another selected conversation and agent", async () => {
  const list = deferred<typeof home>();
  const provider = workspace(() => list.promise);
  const refresh = provider.refreshHome("fork");
  provider.activateConversation("other", "agent-b");
  list.resolve(home);
  await refresh;
  assert.equal(provider.state.conversation, "other");
  assert.equal(provider.state.agent, "agent-b");
});

test("returning to the source still invalidates a pending fork activation", async () => {
  const list = deferred<typeof home>();
  const provider = workspace(() => list.promise);
  const refresh = provider.refreshHome("fork");
  provider.startNewConversation();
  provider.activateConversation("source", "agent-a");
  list.resolve(home);
  await refresh;
  assert.equal(provider.state.conversation, "source");
});

test("navigation during the direct conversation lookup also invalidates activation", async () => {
  const detail = deferred<{ conversation: typeof fork }>();
  const lookupStarted = deferred<void>();
  const provider = workspace(async () => ({ ...home, conversations: [] }), () => {
    lookupStarted.resolve();
    return detail.promise;
  });
  const refresh = provider.refreshHome("fork");
  await lookupStarted.promise;
  provider.startNewConversation();
  detail.resolve({ conversation: fork });
  await refresh;
  assert.equal(provider.state.conversation, null);
});

test("an agent selection invalidates a pending home refresh even without changing the conversation", async () => {
  const list = deferred<typeof home>();
  const provider = workspace(() => list.promise);
  const refresh = provider.refreshHome("fork");
  provider.setActiveAgent("agent-b");
  list.resolve(home);
  await refresh;
  assert.equal(provider.state.agent, "agent-b");
  assert.equal(provider.state.conversation, "source");
});

test("a non-activating refresh updates the list without opening a conversation or changing agents", async () => {
  const provider = workspace(async () => home);
  provider.startNewConversation();
  provider.setActiveAgent("agent-b");
  const url = provider.state.url;
  await provider.refreshHome(undefined, { activate: false });
  assert.equal(provider.state.conversations, home.conversations);
  assert.equal(provider.state.conversation, null);
  assert.equal(provider.state.agent, "agent-b");
  assert.equal(provider.state.url, url);
});

for (const destination of ["new", "other", "source"] as const) {
  test(`a fork response after navigating to ${destination} adds the branch without replacing the current selection or draft`, async () => {
    const created = deferred<ForkConversationResponse>();
    const list = deferred<typeof home>();
    const listStarted = deferred<void>();
    const provider = workspace(() => {
      listStarted.resolve();
      return list.promise;
    }, undefined, () => created.promise);
    const restart = provider.restartFrom({ id: "selected-message" });
    if (destination === "other") provider.activateConversation("other", "agent-b");
    else {
      provider.startNewConversation();
      if (destination === "source") provider.activateConversation("source", "agent-a");
    }
    const current = { ...provider.state };
    created.resolve({ conversationId: "fork", leadAgentKey: "agent-a", text: "fork draft", attachments: [] });
    assert.equal(
      await Promise.race([listStarted.promise.then(() => true), restart.then(() => false)]),
      true,
      "a successfully created fork must trigger a list refresh",
    );
    list.resolve(home);
    await restart;
    assert.equal(provider.state.conversations, home.conversations);
    assert.equal(provider.state.conversation, current.conversation);
    assert.equal(provider.state.agent, current.agent);
    assert.equal(provider.state.url, current.url);
    assert.equal(provider.state.input, current.input);
    assert.equal(provider.state.attachments, current.attachments);
    assert.equal(provider.forkingRef.current, false);
    assert.equal(provider.state.drafts["conversation:fork"].input, "fork draft");
  });
}

test("a current fork response still opens the branch and restores its draft", async () => {
  const provider = workspace(async () => home);
  await provider.restartFrom({ id: "selected-message" });
  assert.equal(provider.state.conversation, "fork");
  assert.equal(provider.state.input, "fork draft");
  assert.equal(provider.state.drafts["conversation:fork"].input, "fork draft");
  assert.equal(provider.state.url, "/chat?conversation=fork");
  assert.equal(provider.forkingRef.current, false);
});

for (const conversations of [home.conversations, []]) {
  test(`archiving the active conversation clears its stale URL${conversations.length ? " without opening another conversation" : " even when the list becomes empty"}`, async () => {
    const provider = workspace(async () => ({ ...home, conversations }));
    await provider.removeConversation("source");
    assert.equal(provider.state.conversation, null);
    assert.match(provider.state.url, /^\/chat\?new=/);
    assert.equal(new URL(provider.state.url, "https://opshelper.test").searchParams.has("conversation"), false);
    assert.equal(provider.state.agent, "agent-a");
  });
}

test("archiving a different conversation preserves the current selection and URL", async () => {
  const provider = workspace(async () => home);
  await provider.removeConversation("fork");
  assert.equal(provider.state.conversation, "source");
  assert.equal(provider.state.url, "/chat?conversation=source");
});

for (const destination of ["chat", "files", "schedules"] as const) {
  test(`a delayed archive does not navigate away from a newly opened ${destination} route`, async () => {
    const archived = deferred<void>();
    const provider = workspace(async () => home, undefined, undefined, () => archived.promise);
    const removing = provider.removeConversation("source");
    if (destination === "chat") provider.activateConversation("other", "agent-b");
    provider.setRoute(destination === "chat" ? "/chat?conversation=other" : `/${destination}`);
    const url = provider.state.url;
    archived.resolve();
    await removing;
    assert.equal(provider.state.url, url);
    assert.equal(provider.state.conversation, destination === "chat" ? "other" : null);
    assert.equal(provider.state.agent, destination === "chat" ? "agent-b" : "agent-a");
  });
}

test("navigating during the post-archive list refresh cannot replace the new selection", async () => {
  const list = deferred<typeof home>();
  const started = deferred<void>();
  const provider = workspace(() => { started.resolve(); return list.promise; });
  const removing = provider.removeConversation("source");
  await started.promise;
  assert.match(provider.state.url, /^\/chat\?new=/, "route cleanup must not wait for list loading");
  provider.activateConversation("other", "agent-b");
  provider.setRoute("/chat?conversation=other");
  list.resolve(home);
  await removing;
  assert.equal(provider.state.conversation, "other");
  assert.equal(provider.state.url, "/chat?conversation=other");
});

test("archive failure leaves the active conversation and URL unchanged", async () => {
  const provider = workspace(async () => home, undefined, undefined, async () => { throw new Error("offline"); });
  await assert.rejects(provider.removeConversation("source"), /offline/);
  assert.equal(provider.state.conversation, "source");
  assert.equal(provider.state.url, "/chat?conversation=source");
});

for (const id of ["source", "fork"]) {
  test(`successful archive of ${id} remains successful when list loading fails`, async () => {
    let archived = 0;
    const provider = workspace(async () => { throw new Error("list offline"); }, undefined, undefined, async () => { archived += 1; });
    provider.state.conversations = [{ id: "source", leadAgentKey: "agent-a" }, ...home.conversations];
    await assert.doesNotReject(provider.removeConversation(id));
    assert.equal(archived, 1);
    assert.equal(provider.state.conversations.some((row) => row.id === id), false);
    assert.equal(provider.state.conversation, id === "source" ? null : "source");
    if (id === "source") assert.match(provider.state.url, /^\/chat\?new=/);
    else assert.equal(provider.state.url, "/chat?conversation=source");
  });
}

test("archive completion and row removal do not wait for list refresh", async () => {
  const list = deferred<typeof home>();
  const provider = workspace(() => list.promise);
  provider.state.conversations = [...home.conversations];
  const removing = provider.removeConversation("fork");
  let completed = false;
  void removing.then(() => { completed = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  list.resolve({ ...home, conversations: [other] });
  assert.equal(completed, true, "archive should complete while list loading is still pending");
  assert.equal(provider.state.conversations.some((row) => row.id === "fork"), false);
  assert.equal(provider.state.conversation, "source");
  await removing;
});

test("failed archive retains the row and does not start list refresh", async () => {
  let refreshes = 0;
  const provider = workspace(async () => { refreshes += 1; return home; }, undefined, undefined, async () => { throw new Error("delete offline"); });
  provider.state.conversations = [...home.conversations];
  await assert.rejects(provider.removeConversation("fork"), /delete offline/);
  assert.equal(provider.state.conversations.some((row) => row.id === "fork"), true);
  assert.equal(refreshes, 0);
});
