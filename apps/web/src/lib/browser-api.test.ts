import assert from "node:assert/strict";
import test from "node:test";

import {
  createAgent,
  createSkillRepositorySkill,
  deleteAgent,
  deleteSkillRepositorySkill,
  getSkillRepositorySkill,
  importAgentSkillPackage,
  listSkillRepository,
} from "./browser-api";

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

test("技能仓库列表使用公共只读接口", async () => {
  const originalFetch = globalThis.fetch;
  let request: { path: string; cache?: RequestCache } | null = null;
  globalThis.fetch = (async (input, init) => {
    request = {
      path: String(input),
      cache: init?.cache,
    };
    return new Response(JSON.stringify({ skills: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    await listSkillRepository();
    assert.deepEqual(request, {
      path: "/v1/skill-repository",
      cache: "no-store",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("技能仓库详情读取会编码技能名", async () => {
  const originalFetch = globalThis.fetch;
  let requestPath = "";
  globalThis.fetch = (async (input) => {
    requestPath = String(input);
    return new Response(JSON.stringify({
      skillName: "network/ops",
      files: {},
      binaryFiles: {},
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    await getSkillRepositorySkill("network/ops");
    assert.equal(requestPath, "/v1/skill-repository/network%2Fops");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("管理员上传仓库技能使用管理接口", async () => {
  const originalFetch = globalThis.fetch;
  let request: { path: string; method?: string; isFormData: boolean } | null = null;
  globalThis.fetch = (async (input, init) => {
    request = {
      path: String(input),
      method: init?.method,
      isFormData: init?.body instanceof FormData,
    };
    return new Response(JSON.stringify({
      skill: { name: "diag", description: "d", fileCount: 1, updatedAt: new Date().toISOString() },
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const file = new File([new Uint8Array([1, 2, 3])], "diag.zip", { type: "application/zip" });
    await createSkillRepositorySkill(file);
    assert.deepEqual(request, {
      path: "/v1/admin/skill-repository/skill-package",
      method: "POST",
      isFormData: true,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("管理员删除仓库技能会编码技能名并发送 DELETE", async () => {
  const originalFetch = globalThis.fetch;
  let request: { path: string; method?: string } | null = null;
  globalThis.fetch = (async (input, init) => {
    request = { path: String(input), method: init?.method };
    return new Response(null, { status: 204 });
  }) as typeof fetch;

  try {
    await deleteSkillRepositorySkill("network/ops");
    assert.deepEqual(request, {
      path: "/v1/admin/skill-repository/network%2Fops",
      method: "DELETE",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("智能体编辑器直接上传 Skill 包仍使用当前智能体导入接口，不走仓库管理接口", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input) => {
    requests.push(String(input));
    return new Response(JSON.stringify({ skillName: "local-skill", files: {}, binaryFiles: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const file = new File([new Uint8Array([1, 2, 3])], "local-skill.zip", { type: "application/zip" });
    await importAgentSkillPackage(file, "admin");
    await importAgentSkillPackage(file, "user");
    assert.deepEqual(requests, [
      "/v1/admin/agents/skill-package",
      "/v1/users/me/agent-catalog/skill-package",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
