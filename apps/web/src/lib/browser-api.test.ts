import assert from "node:assert/strict";
import test from "node:test";

import { deleteAgent } from "./browser-api";

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
