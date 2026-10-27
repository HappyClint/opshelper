import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

import { AgentServiceError } from "../lib/agent-service";
import {
  assertAdminAgentSelection,
  createOwnedAgentAndAssign,
  createAgentFromCatalog,
  registerAgentDeleteRoute,
  registerAgentRoutes,
  type AgentDeleteRouteServices,
  type UserOwnedAgentCreateServices,
} from "./agents";

function services(
  overrides: Partial<AgentDeleteRouteServices> = {},
): AgentDeleteRouteServices {
  return {
    requireAdmin: async () => ({ id: "admin", role: "admin" }) as any,
    resolveAgentId: async () => "agent-id",
    withAgentLocks: async (_agentIds, callback) => callback(),
    deleteAgent: async () => undefined,
    ...overrides,
  };
}

test("管理员删除智能体时持有智能体配置锁并返回 204", async () => {
  const calls: unknown[] = [];
  const app = Fastify();
  registerAgentDeleteRoute(app, services({
    resolveAgentId: async (key) => {
      calls.push(["resolve", key]);
      return "agent-id";
    },
    withAgentLocks: async (agentIds, callback) => {
      calls.push(["lock", agentIds]);
      return callback();
    },
    deleteAgent: async (key) => {
      calls.push(["delete", key]);
    },
  }));
  try {
    const response = await app.inject({
      method: "DELETE",
      url: "/v1/admin/agents/network-ops",
    });
    assert.equal(response.statusCode, 204);
    assert.deepEqual(calls, [
      ["resolve", "network-ops"],
      ["lock", ["agent-id"]],
      ["delete", "network-ops"],
    ]);
  } finally {
    await app.close();
  }
});

test("完整智能体管理路由包含 DELETE 接口", async () => {
  const app = Fastify();
  await registerAgentRoutes(app);
  try {
    assert.equal(app.hasRoute({
      method: "DELETE",
      url: "/v1/admin/agents/:key",
    }), true);
    assert.equal(app.hasRoute({
      method: "GET",
      url: "/v1/users/me/agent-catalog",
    }), true);
    assert.equal(app.hasRoute({
      method: "POST",
      url: "/v1/users/me/agent-catalog",
    }), true);
    assert.equal(app.hasRoute({
      method: "POST",
      url: "/v1/users/me/agent-catalog/:key/check",
    }), true);
  } finally {
    await app.close();
  }
});

test("删除仍分配给用户的智能体时返回明确的 409", async () => {
  const app = Fastify();
  registerAgentDeleteRoute(app, services({
    deleteAgent: async () => {
      throw new AgentServiceError("Agent 仍分配给用户，请先撤销分配", 409);
    },
  }));
  try {
    const response = await app.inject({
      method: "DELETE",
      url: "/v1/admin/agents/network-ops",
    });
    assert.equal(response.statusCode, 409);
    assert.equal(response.json().message, "Agent 仍分配给用户，请先撤销分配");
  } finally {
    await app.close();
  }
});

test("非管理员不能调用智能体删除服务", async () => {
  let called = false;
  const app = Fastify();
  registerAgentDeleteRoute(app, services({
    requireAdmin: async (_request, reply) => {
      await reply.code(403).send({ message: "Admin access required" });
      return null;
    },
    deleteAgent: async () => {
      called = true;
    },
  }));
  try {
    const response = await app.inject({
      method: "DELETE",
      url: "/v1/admin/agents/network-ops",
    });
    assert.equal(response.statusCode, 403);
    assert.equal(called, false);
  } finally {
    await app.close();
  }
});

test("管理员只能新增共享智能体分配，不能新增普通用户的私有智能体", () => {
  const agents = [
    { id: "shared", key: "shared-agent", ownerId: null },
    { id: "private", key: "private-agent", ownerId: "user-1" },
    { id: "legacy-admin", key: "legacy-admin-agent", ownerId: "admin-1", ownerRole: "ADMIN" },
  ];

  assert.doesNotThrow(() => assertAdminAgentSelection(["shared"], agents, new Set()));
  assert.doesNotThrow(() => assertAdminAgentSelection(["legacy-admin"], agents, new Set()));
  assert.throws(
    () => assertAdminAgentSelection(["private"], agents, new Set()),
    (error: unknown) => error instanceof AgentServiceError && error.statusCode === 403,
  );
});

test("管理员保存分配时可以保留既有私有智能体，但不能将其作为新分配", () => {
  const agents = [{ id: "private", key: "private-agent", ownerId: "user-1" }];

  assert.doesNotThrow(() => assertAdminAgentSelection(["private"], agents, new Set(["private"])));
  assert.throws(
    () => assertAdminAgentSelection(["private"], agents, new Set()),
    (error: unknown) => error instanceof AgentServiceError && error.statusCode === 403,
  );
});

test("管理员从个人智能体目录创建共享智能体，普通用户仍走私有自动分配流程", async () => {
  const calls: unknown[] = [];
  const services = {
    createSharedAgent: async (input: {
      key: string;
      files: Record<string, string | Uint8Array>;
      ownerId?: string | null;
    }) => {
      calls.push(["shared", input.ownerId]);
      return { id: "shared-id" };
    },
    createOwnedAgent: async (
      userId: string,
      _input: { key: string; files: Record<string, string | Uint8Array> },
    ) => {
      calls.push(["owned", userId]);
      return { id: "private-id" };
    },
  };

  await createAgentFromCatalog(
    { id: "admin-1", role: "admin" },
    { key: "shared-agent", files: {} },
    services,
  );
  await createAgentFromCatalog(
    { id: "user-1", role: "user" },
    { key: "private-agent", files: {} },
    services,
  );

  assert.deepEqual(calls, [["shared", null], ["owned", "user-1"]]);
});

function userCreateServices(
  overrides: Partial<UserOwnedAgentCreateServices> = {},
): UserOwnedAgentCreateServices {
  return {
    previewAgent: async () => ({
      key: "network",
      displayName: "Network",
      description: "desc",
      mode: "all",
      contentHash: "hash",
      model: null,
      tools: [],
      skills: [],
      scripts: [],
      mcp: {},
      sourceDir: "/tmp/source",
    }),
    createAgent: async () => ({ id: "agent-id", key: "network" } as any),
    deleteAgent: async () => undefined,
    listUserAgentAssignments: async () => [],
    replaceUserAgentAssignments: async () => [],
    ensureContainerRecordForUser: async () => undefined as any,
    withAgentConfigLocks: async (_agentIds, callback) => callback(),
    withUserConfigLock: async (_userId, callback) => callback({} as any),
    applyUserRuntimeConfiguration: async () => undefined,
    ...overrides,
  };
}

test("普通用户仅创建 subagent 且无主智能体时会在创建前被拒绝", async () => {
  let created = false;
  await assert.rejects(
    createOwnedAgentAndAssign(
      "user-1",
      { key: "network-sub", files: { "agent.md": "---\nname: n\ndescription: d\nmode: subagent\n---\nbody" } },
      userCreateServices({
        previewAgent: async () => ({
          key: "network-sub",
          displayName: "Network Sub",
          description: "desc",
          mode: "subagent",
          contentHash: "hash",
          model: null,
          tools: [],
          skills: [],
          scripts: [],
          mcp: {},
          sourceDir: "/tmp/source",
        }),
        createAgent: async () => {
          created = true;
          return { id: "agent-id", key: "network-sub" } as any;
        },
      }),
    ),
    /至少需要分配一个 primary 或 all 模式的主智能体/,
  );
  assert.equal(created, false);
});

test("自动分配失败时会回滚到创建前分配并删除新智能体", async () => {
  const calls: unknown[] = [];
  let applyAttempt = 0;
  await assert.rejects(
    createOwnedAgentAndAssign(
      "user-1",
      { key: "network-sub", files: { "agent.md": "---\nname: n\ndescription: d\nmode: subagent\n---\nbody" } },
      userCreateServices({
        listUserAgentAssignments: async () => [{ agentId: "lead-id", agent: { mode: "all" } } as any],
        createAgent: async () => {
          calls.push(["create"]);
          return { id: "new-id", key: "network-sub" } as any;
        },
        replaceUserAgentAssignments: async (_userId, agentIds) => {
          calls.push(["replace", [...agentIds]]);
          return [];
        },
        deleteAgent: async (key) => {
          calls.push(["delete", key]);
        },
        applyUserRuntimeConfiguration: async () => {
          applyAttempt += 1;
          calls.push(["apply", applyAttempt]);
          if (applyAttempt === 1) throw new AgentServiceError("装配失败", 409);
        },
      }),
    ),
    /装配失败/,
  );
  assert.deepEqual(calls, [
    ["create"],
    ["replace", ["lead-id", "new-id"]],
    ["apply", 1],
    ["replace", ["lead-id"]],
    ["delete", "network-sub"],
    ["apply", 2],
  ]);
});
