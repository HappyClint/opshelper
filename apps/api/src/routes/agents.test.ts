import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

import { AgentServiceError } from "../lib/agent-service";
import {
  registerAgentDeleteRoute,
  registerAgentRoutes,
  type AgentDeleteRouteServices,
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
