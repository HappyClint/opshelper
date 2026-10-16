import assert from "node:assert/strict";
import test from "node:test";

import { createAgent, deleteAgent } from "./browser-api";

test("deleteAgent 使用编码后的管理接口并发送 DELETE", async () => {
  const originalFetch = globalThis.fetch;
  let request: { path: string; method?: string } | null = null;
  globalThis.fetch = (async (input, init) => {
    request = {
      path: String(input),
      method: init?.method,
    };
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  try {
    await deleteAgent("network/ops");
    assert.deepEqual(request, {
      path: "/v1/admin/agents/network%2Fops",
      method: "DELETE",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("普通用户创建智能体使用个人目录接口", async () => {
  const originalFetch = globalThis.fetch;
  let request: { path: string; method?: string; body?: string } | null = null;
  globalThis.fetch = (async (input, init) => {
    request = {
      path: String(input),
      method: init?.method,
      body: typeof init?.body === "string" ? init.body : undefined,
    };
    return new Response(JSON.stringify({ agent: { key: "personal-ops" } }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    await createAgent({
      key: "personal-ops",
      files: { "agent.md": "---\nname: Personal\ndescription: test\nmode: all\n---\nbody" },
    }, "user");
    assert.deepEqual(request, {
      path: "/v1/users/me/agent-catalog",
      method: "POST",
      body: JSON.stringify({
        key: "personal-ops",
        files: { "agent.md": "---\nname: Personal\ndescription: test\nmode: all\n---\nbody" },
      }),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("普通用户删除智能体使用个人目录接口", async () => {
  const originalFetch = globalThis.fetch;
  let request: { path: string; method?: string } | null = null;
  globalThis.fetch = (async (input, init) => {
    request = {
      path: String(input),
      method: init?.method,
    };
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  try {
    await deleteAgent("personal-ops", "user");
    assert.deepEqual(request, {
      path: "/v1/users/me/agent-catalog/personal-ops",
      method: "DELETE",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
