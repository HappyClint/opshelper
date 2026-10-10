import assert from "node:assert/strict";
import test from "node:test";

import { refreshNativeTaskPermissions, refreshNativeSessionTreeTaskPermissions } from "./native-session-permissions";

type Rule = { permission: string; pattern: string; action: string };
const allowTask: Rule = { permission: "task", pattern: "*", action: "allow" };
const leadDeny: Rule = { permission: "task", pattern: "lead", action: "deny" };
const subAllow: Rule = { permission: "task", pattern: "sub", action: "allow" };
const readDeny: Rule = { permission: "read", pattern: "/private/*", action: "deny" };
const desired = [allowTask, leadDeny, subAllow];

function fixture(permission: Rule[]) {
  const state = { permission, metadata: { existing: "preserve" } as Record<string, unknown> };
  const messages = new Set(["msg_original_user", "msg_original_assistant"]);
  const calls: string[] = [];
  let failAfterReset = false;
  let busy = false;
  const request = async <T>(method: string, route: string, body?: unknown): Promise<T> => {
    calls.push(`${method} ${route}`);
    if (method === "GET" && route === "/session/status") return (busy ? { legacy: { type: "busy" } } : {}) as T;
    if (method === "GET") return structuredClone(state) as T;
    const payload = body as { metadata?: Record<string, unknown>; permission?: Rule[]; messageID: string; noReply: boolean; tools: {task: boolean}; parts: unknown[] };
    if (method === "PATCH") {
      if (payload.metadata) state.metadata = structuredClone(payload.metadata);
      // Match OpenCode 1.18: PATCH concatenates, never replaces or deduplicates.
      if (payload.permission) state.permission.push(...payload.permission);
    } else if (method === "POST") {
      assert.equal(payload.noReply, true);
      assert.deepEqual(payload.parts, []);
      assert.deepEqual(payload.tools, { task: true });
      messages.add(payload.messageID);
      state.permission = [allowTask];
      if (failAfterReset) { failAfterReset = false; throw new Error("response lost after reset"); }
    } else {
      const id = route.split("/").at(-1)!;
      assert.ok(id.startsWith("msg_opshelper_permissions_"));
      messages.delete(id);
    }
    return true as T;
  };
  const refresh = () => refreshNativeTaskPermissions({ sessionID: "legacy", agent: "lead", permission: desired, request });
  return { state, messages, calls, refresh, loseResetResponse: () => { failAfterReset = true; }, makeBusy: () => { busy = true; } };
}

test("legacy wildcard deny is removed, unrelated rules and original history remain, repeat dispatch does not append rules", async () => {
  const f = fixture([readDeny, { ...allowTask, action: "deny" }, subAllow, ...desired]);
  await f.refresh();
  assert.ok(!f.state.permission.some((r) => r.permission === "task" && r.pattern === "*" && r.action === "deny"));
  assert.deepEqual(f.state.permission.filter((r) => r.permission !== "task"), [readDeny]);
  assert.deepEqual([...f.messages], ["msg_original_user", "msg_original_assistant"]);
  assert.deepEqual(f.state.metadata, { existing: "preserve" });
  const before = structuredClone(f.state);
  f.calls.length = 0;
  await f.refresh();
  assert.deepEqual(f.state, before);
  assert.deepEqual(f.calls, ["GET /session/legacy"]);
});

test("primary to delegable removes superseded specific deny instead of inheriting it", async () => {
  const f = fixture([allowTask, leadDeny, { ...subAllow, action: "deny" }, ...desired]);
  await f.refresh();
  assert.ok(!f.state.permission.some((r) => r.permission === "task" && r.pattern === "sub" && r.action === "deny"));
  assert.ok(f.state.permission.some((r) => r.pattern === "lead" && r.action === "deny"));
});

test("a lost reset response retains durable intent and restores unrelated denials on retry", async () => {
  const f = fixture([readDeny, { ...allowTask, action: "deny" }, subAllow]);
  f.loseResetResponse();
  await assert.rejects(f.refresh(), /response lost/);
  assert.ok(f.state.metadata.opshelperTaskPermissionMigrationV1);
  await f.refresh();
  assert.deepEqual(f.state.permission.filter((r) => r.permission !== "task"), [readDeny]);
  assert.deepEqual([...f.messages], ["msg_original_user", "msg_original_assistant"]);
  assert.deepEqual(f.state.metadata, { existing: "preserve" });
});

test("busy native session is rejected before any permissions or messages change", async () => {
  const f = fixture([{ ...allowTask, action: "deny" }]);
  const before = structuredClone(f.state);
  f.makeBusy();
  await assert.rejects(f.refresh(), /session is active/);
  assert.deepEqual(f.state, before);
  assert.deepEqual([...f.messages], ["msg_original_user", "msg_original_assistant"]);
  assert.ok(f.calls.every((call) => call.startsWith("GET")));
});

test("tree refresh only visits the selected root and its descendants", async () => {
  const visited: string[] = [];
  const request = async <T>(method: string, route: string): Promise<T> => {
    assert.equal(method, "GET");
    if (route.endsWith("/children")) {
      const children: Record<string, Array<{ id: string }>> = {
        "/session/root/children": [{ id: "child" }],
        "/session/child/children": [{ id: "leaf" }],
        "/session/leaf/children": [],
      };
      assert.ok(route in children);
      return children[route] as T;
    }
    visited.push(route);
    return { permission: desired } as T;
  };
  await refreshNativeSessionTreeTaskPermissions({ sessionID: "root", agent: "lead", permission: desired, request });
  assert.deepEqual(visited, ["/session/root", "/session/child", "/session/leaf"]);
});
