import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";

import {
  ConversationServiceError,
} from "../lib/conversation-service";
import {
  registerConversationRoutes,
  type ConversationRouteServices,
} from "./conversations";

function services(overrides: Partial<ConversationRouteServices> = {}): ConversationRouteServices {
  return {
    requireSession: async () => ({
      id: "owner-user",
      name: "Owner",
      username: "owner",
      role: "user",
      isActive: true,
    }) as any,
    listConversationHome: async () => ({ agents: [], conversations: [], executionBlockedReason: null }),
    createConversation: async () => ({ id: "conversation-created" }) as any,
    forkConversation: async () => ({ conversationId: "fork-created", leadAgentKey: "network-ops", text: "", attachments: [] }),
    getCollaborationSnapshot: async () => ({}) as any,
    getConversationSnapshot: async () => ({ conversation: { id: "conversation-owned" } }) as any,
    openConversationEvents: async () => (async function* () { yield "event: ready\ndata: {}\n\n"; })(),
    archiveConversation: async () => ({ id: "conversation-owned" }) as any,
    enqueueExecution: async () => ({ id: "execution-created" }) as any,
    abortExecution: async () => ({ status: "CANCELLED" }) as any,
    reconcileInterruptedExecution: async () => ({ status: "SUCCEEDED", error: null }) as any,
    replyConversationQuestion: async () => ({ conversation: { id: "conversation-owned" } }) as any,
    replyConversationPermission: async () => ({ conversation: { id: "conversation-owned" } }) as any,
    ...overrides,
  };
}

test("重新开始只接受消息编号，使用登录归属并返回分支草稿", async () => {
  const calls: unknown[] = [];
  const app = Fastify();
  await registerConversationRoutes(app, services({
    forkConversation: async (input) => {
      calls.push(input);
      if (input.conversationId === "foreign") throw new ConversationServiceError("对话不存在", 404);
      if (input.messageId === "busy") throw new ConversationServiceError("请等待执行完成", 409);
      return { conversationId: "fork", leadAgentKey: "network-ops", text: "重新检查", attachments: [] };
    },
  }));
  try {
    const fork = await app.inject({ method: "POST", url: "/v1/conversations/owned/fork", payload: { messageId: "msg-saved" } });
    assert.equal(fork.statusCode, 201);
    assert.equal(fork.json().text, "重新检查");
    assert.deepEqual(calls[0], { userId: "owner-user", conversationId: "owned", messageId: "msg-saved" });
    for (const payload of [{}, { messageId: "" }, { messageId: "msg", userId: "foreign" }, { messageId: "msg", nativeSessionId: "ses-forged" }]) {
      assert.equal((await app.inject({ method: "POST", url: "/v1/conversations/owned/fork", payload })).statusCode, 400);
    }
    assert.equal(calls.length, 1);
    assert.equal((await app.inject({ method: "POST", url: "/v1/conversations/foreign/fork", payload: { messageId: "msg" } })).statusCode, 404);
    assert.equal((await app.inject({ method: "POST", url: "/v1/conversations/owned/fork", payload: { messageId: "busy" } })).statusCode, 409);
  } finally { await app.close(); }
});

test("会话接口只使用登录用户归属，不接受客户端原生会话或用户标识", async () => {
  const calls: unknown[] = [];
  const app = Fastify();
  await registerConversationRoutes(app, services({
    getConversationSnapshot: async (userId, conversationId) => {
      calls.push(["get", userId, conversationId]);
      return { conversation: { id: conversationId } } as any;
    },
    enqueueExecution: async (input) => {
      calls.push(["enqueue", input]);
      return { id: "execution-created" } as any;
    },
  }));
  try {
    assert.equal((await app.inject("/v1/conversations/conversation-a")).statusCode, 200);
    assert.deepEqual(calls[0], ["get", "owner-user", "conversation-a"]);

    const extraConversation = await app.inject({
      method: "POST",
      url: "/v1/conversations",
      payload: { leadAgentKey: "network-ops", nativeSessionId: "native-forged" },
    });
    assert.equal(extraConversation.statusCode, 400);

    const extraExecution = await app.inject({
      method: "POST",
      url: "/v1/conversations/conversation-a/executions",
      payload: {
        requestKey: "request-12345678",
        leadAgentKey: "network-ops",
        text: "检查网络",
        userId: "other-user",
        sessionId: "native-forged",
      },
    });
    assert.equal(extraExecution.statusCode, 400);

    const valid = await app.inject({
      method: "POST",
      url: "/v1/conversations/conversation-a/executions",
      payload: {
        requestKey: "request-12345678",
        leadAgentKey: "network-ops",
        text: "检查网络",
      },
    });
    assert.equal(valid.statusCode, 202);
    assert.deepEqual(calls[1], ["enqueue", {
      userId: "owner-user",
      conversationId: "conversation-a",
      requestKey: "request-12345678",
      leadAgentKey: "network-ops",
      text: "检查网络",
      attachments: [],
      model: undefined,
      autoApprovePermissions: false,
    }]);
  } finally {
    await app.close();
  }
});

test("幂等冲突保留409，权限接口只允许单次批准或拒绝", async () => {
  const app = Fastify();
  await registerConversationRoutes(app, services({
    enqueueExecution: async () => {
      throw new ConversationServiceError("重复请求标识对应的任务内容不一致", 409);
    },
  }));
  try {
    const conflict = await app.inject({
      method: "POST",
      url: "/v1/conversations/conversation-a/executions",
      payload: {
        requestKey: "request-12345678",
        leadAgentKey: "network-ops",
        text: "检查网络",
      },
    });
    assert.equal(conflict.statusCode, 409);

    const always = await app.inject({
      method: "POST",
      url: "/v1/executions/execution-a/permissions/permission-a/reply",
      payload: { response: "always" },
    });
    assert.equal(always.statusCode, 400);
  } finally {
    await app.close();
  }
});

test("流式接口验证登录和会话归属，使用SSE且关闭代理缓冲", async () => {
  const calls: unknown[] = [];
  const app = Fastify();
  await registerConversationRoutes(app, services({
    openConversationEvents: async (userId, conversationId, signal) => {
      calls.push([userId, conversationId, signal.aborted]);
      if (conversationId === "foreign") throw new ConversationServiceError("对话不存在", 404);
      return (async function* () {
        yield "event: ready\ndata: {}\n\n";
        yield 'event: text\ndata: {"messageId":"m","partId":"p","text":"你"}\n\n';
        yield 'event: text\ndata: {"messageId":"m","partId":"p","text":"你好"}\n\n';
      })();
    },
  }));
  try {
    const response = await app.inject("/v1/conversations/owned/events");
    assert.equal(response.statusCode, 200);
    assert.match(String(response.headers["content-type"]), /text\/event-stream/);
    assert.equal(response.headers["x-accel-buffering"], "no");
    assert.match(String(response.headers["cache-control"]), /no-transform/);
    assert.equal(response.body.match(/event: text/g)?.length, 2);
    assert.deepEqual(calls[0], ["owner-user", "owned", false]);
    assert.equal((await app.inject("/v1/conversations/foreign/events")).statusCode, 404);
  } finally { await app.close(); }

  const unauthenticated = Fastify();
  await registerConversationRoutes(unauthenticated, services({
    requireSession: async (_request, reply) => { reply.code(401).send({ message: "请登录" }); return null; },
    openConversationEvents: async () => { throw new Error("未登录不能打开上游"); },
  }));
  try {
    assert.equal((await unauthenticated.inject("/v1/conversations/owned/events")).statusCode, 401);
  } finally { await unauthenticated.close(); }
});

test("子会话进度入口使用登录归属并拒绝无效编号", async () => {
  const calls: unknown[] = [];
  const app = Fastify();
  await registerConversationRoutes(app, services({
    getCollaborationSnapshot: async (...args) => {
      calls.push(args);
      throw new ConversationServiceError("子智能体会话不存在", 404);
    },
  }));
  try {
    assert.equal((await app.inject("/v1/conversations/owned/collaborations/095b4ffa8b86")).statusCode, 404);
    assert.deepEqual(calls, [["owner-user", "owned", "095b4ffa8b86"]]);
    assert.equal((await app.inject("/v1/conversations/owned/collaborations/ses_forged")).statusCode, 400);
    assert.equal(calls.length, 1);
  } finally { await app.close(); }
});
