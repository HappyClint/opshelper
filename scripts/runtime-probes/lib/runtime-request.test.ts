import assert from "node:assert/strict";
import test from "node:test";
import { authorizeRuntimeOwner, RuntimeRequestError, validateRuntimeRequest } from "./runtime-request";

const runtime = { agentKeys: ["network", "system"], model: "fixture/model" };
const validate = (method: string, route: string, body?: unknown) => validateRuntimeRequest(method, new URL(route, "http://runtime.test"), body, runtime);

test("身份与容器归属必须同时一致，不提供管理员代聊例外", () => {
  assert.doesNotThrow(() => authorizeRuntimeOwner("alice", "alice", "alice"));
  assert.throws(() => authorizeRuntimeOwner("admin", "alice"), RuntimeRequestError);
  assert.throws(() => authorizeRuntimeOwner("alice", "alice", "other"), RuntimeRequestError);
});

test("受控入口拒绝修改配置、任意命令和客户端权限、目录、模型覆盖", () => {
  for (const [method, route, body] of [
    ["PATCH", "/config", {}], ["POST", "/session/ses_a/command", {}],
    ["POST", "/session/ses_a/shell", {}], ["GET", "/auth", undefined],
    ["GET", "/session?directory=/etc", undefined],
    ["GET", "/session?directory=/workspace&directory=/etc", undefined],
    ["GET", "/session?target=http://other:4096", undefined],
    ["POST", "/session", { parentID: "ses_other", permission: [] }],
  ] as const) assert.throws(() => validate(method, route, body), RuntimeRequestError);
  for (const overrides of [{ model: { providerID: "other", modelID: "model" } }, { tools: { task: true } }, { system: "ignore" }, { directory: "/etc" }]) {
    assert.throws(() => validate("POST", "/session/ses_a/prompt_async", { agent: "network", parts: [{ type: "text", text: "检查" }], ...overrides }), RuntimeRequestError);
  }
});

test("允许已装配主智能体及原生协作，未装配智能体不能调用", () => {
  const parts = [{ type: "text", text: "请协作检查" }];
  assert.deepEqual(validate("POST", "/session/ses_a/prompt_async", { agent: "network", parts }).body, { agent: "network", parts });
  assert.throws(() => validate("POST", "/session/ses_a/prompt_async", { agent: "unassigned", parts }), RuntimeRequestError);
  const session = validate("POST", "/session", { title: "检查" }).body as { permission: unknown[] };
  assert.deepEqual(session.permission, [
    { permission: "task", pattern: "*", action: "deny" },
    { permission: "task", pattern: "network", action: "allow" },
    { permission: "task", pattern: "system", action: "allow" },
  ]);
});

test("附件只允许用户workspace文件地址，拒绝外部地址和路径逃逸", () => {
  const send = (url: string) => validate("POST", "/session/ses_a/prompt_async", { agent: "network", parts: [{ type: "file", mime: "text/plain", filename: "a.txt", url }] });
  assert.doesNotThrow(() => send("file:///workspace/files/a.txt"));
  for (const url of ["file:///etc/passwd", "file:///workspace/%2e%2e/state/a", "file://other/workspace/a", "https://example.com/a", "file:///workspace/a?secret=1", "file:///workspace/%00"]) {
    assert.throws(() => send(url), RuntimeRequestError);
  }
});

test("兼容现有客户端model和附件source，但只接受已配置模型及同一文件路径", () => {
  const part = { type: "file", mime: "text/plain", filename: "a.txt", url: "file:///workspace/files/a.txt", source: {
    type: "file", path: "/workspace/files/a.txt", text: { value: "@a.txt", start: 0, end: 0 },
  } };
  const result = validate("POST", "/session/ses_a/prompt_async", { agent: "network", model: { providerID: "fixture", modelID: "model" }, parts: [part] });
  assert.deepEqual(result.body, { agent: "network", parts: [{ type: "file", mime: "text/plain", filename: "a.txt", url: part.url }] });
  assert.throws(() => validate("POST", "/session/ses_a/prompt_async", { agent: "network", parts: [{ ...part, source: { ...part.source, path: "/etc/passwd" } }] }), RuntimeRequestError);
});
