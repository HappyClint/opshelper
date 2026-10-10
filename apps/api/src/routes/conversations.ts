import type { FastifyInstance, FastifyReply } from "fastify";
import { Readable } from "node:stream";
import { z } from "zod";

import {
  ConversationServiceError,
  abortExecution,
  archiveConversation,
  createConversation,
  enqueueExecution,
  forkConversation,
  getConversationSnapshot,
  getCollaborationSnapshot,
  listConversationHome,
  openConversationEvents,
  reconcileInterruptedExecution,
  replyConversationPermission,
  replyConversationQuestion,
} from "../lib/conversation-service";
import { requireSession } from "../lib/session";

const id = z.string().min(1).max(128);
const agentKey = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const attachment = z.object({
  path: z.string().min(1).max(4096),
  filename: z.string().min(1).max(255),
  mime: z.string().min(1).max(128),
}).strict();
const createConversationSchema = z.object({
  leadAgentKey: agentKey,
  title: z.string().trim().min(1).max(120).optional(),
}).strict();
const createExecutionSchema = z.object({
  requestKey: z.string().regex(/^[A-Za-z0-9-]{8,128}$/),
  leadAgentKey: agentKey,
  text: z.string().max(100_000).default(""),
  attachments: z.array(attachment).max(20).default([]),
  model: z.string().max(256).optional(),
  autoApprovePermissions: z.boolean().default(false),
}).strict();
const forkConversationSchema = z.object({ messageId: id }).strict();
const questionReplySchema = z.object({
  answers: z.array(z.array(z.string().max(10_000)).max(20)).max(20),
}).strict();
const permissionReplySchema = z.object({
  response: z.enum(["once", "reject"]),
}).strict();

function invalid(reply: FastifyReply, message = "请求内容不正确") {
  return reply.code(400).send({ message });
}

function sendServiceError(error: unknown, reply: FastifyReply) {
  if (error instanceof ConversationServiceError) {
    return reply.code(error.statusCode).send({ message: error.message });
  }
  throw error;
}

export interface ConversationRouteServices {
  requireSession: typeof requireSession;
  listConversationHome: typeof listConversationHome;
  createConversation: typeof createConversation;
  forkConversation: typeof forkConversation;
  getConversationSnapshot: typeof getConversationSnapshot;
  getCollaborationSnapshot: typeof getCollaborationSnapshot;
  openConversationEvents: typeof openConversationEvents;
  archiveConversation: typeof archiveConversation;
  enqueueExecution: typeof enqueueExecution;
  abortExecution: typeof abortExecution;
  reconcileInterruptedExecution: typeof reconcileInterruptedExecution;
  replyConversationQuestion: typeof replyConversationQuestion;
  replyConversationPermission: typeof replyConversationPermission;
}

const defaultServices: ConversationRouteServices = {
  requireSession,
  listConversationHome,
  createConversation,
  forkConversation,
  getConversationSnapshot,
  getCollaborationSnapshot,
  openConversationEvents,
  archiveConversation,
  enqueueExecution,
  abortExecution,
  reconcileInterruptedExecution,
  replyConversationQuestion,
  replyConversationPermission,
};

export async function registerConversationRoutes(
  app: FastifyInstance,
  services: ConversationRouteServices = defaultServices,
) {
  const streams = new Set<AbortController>();
  app.addHook("preClose", async () => {
    for (const stream of streams) stream.abort();
  });
  app.get("/v1/conversations", async (request, reply) => {
    const user = await services.requireSession(request, reply);
    if (!user) return;
    return services.listConversationHome(user.id);
  });

  app.post("/v1/conversations", async (request, reply) => {
    const user = await services.requireSession(request, reply);
    if (!user) return;
    const parsed = createConversationSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    try {
      const conversation = await services.createConversation({ userId: user.id, ...parsed.data });
      return reply.code(201).send({ conversationId: conversation.id });
    } catch (error) {
      return sendServiceError(error, reply);
    }
  });

  app.get<{ Params: { conversationId: string } }>(
    "/v1/conversations/:conversationId/events",
    async (request, reply) => {
      const user = await services.requireSession(request, reply);
      if (!user) return;
      if (!id.safeParse(request.params.conversationId).success) return invalid(reply);
      const controller = new AbortController();
      streams.add(controller);
      const close = () => {
        controller.abort();
        streams.delete(controller);
      };
      reply.raw.once("close", close);
      try {
        const events = await services.openConversationEvents(user.id, request.params.conversationId, controller.signal);
        reply.header("Content-Type", "text/event-stream; charset=utf-8");
        reply.header("Cache-Control", "no-cache, no-transform");
        reply.header("X-Accel-Buffering", "no");
        return reply.send(Readable.from(events));
      } catch (error) {
        close();
        return sendServiceError(error, reply);
      }
    },
  );

  app.post<{ Params: { conversationId: string } }>(
    "/v1/conversations/:conversationId/fork",
    async (request, reply) => {
      const user = await services.requireSession(request, reply);
      if (!user) return;
      const parsed = forkConversationSchema.safeParse(request.body);
      if (!id.safeParse(request.params.conversationId).success || !parsed.success) return invalid(reply);
      try {
        return reply.code(201).send(await services.forkConversation({
          userId: user.id,
          conversationId: request.params.conversationId,
          messageId: parsed.data.messageId,
        }));
      } catch (error) {
        return sendServiceError(error, reply);
      }
    },
  );

  app.get<{ Params: { conversationId: string } }>(
    "/v1/conversations/:conversationId",
    async (request, reply) => {
      const user = await services.requireSession(request, reply);
      if (!user) return;
      if (!id.safeParse(request.params.conversationId).success) return invalid(reply);
      try {
        return await services.getConversationSnapshot(user.id, request.params.conversationId);
      } catch (error) {
        return sendServiceError(error, reply);
      }
    },
  );

  app.get<{ Params: { conversationId: string; traceId: string } }>(
    "/v1/conversations/:conversationId/collaborations/:traceId",
    async (request, reply) => {
      const user = await services.requireSession(request, reply);
      if (!user) return;
      const { conversationId, traceId } = request.params;
      if (!id.safeParse(conversationId).success || !/^[a-f0-9]{12}$/.test(traceId)) return invalid(reply);
      try {
        return await services.getCollaborationSnapshot(user.id, conversationId, traceId);
      } catch (error) {
        return sendServiceError(error, reply);
      }
    },
  );

  app.delete<{ Params: { conversationId: string } }>(
    "/v1/conversations/:conversationId",
    async (request, reply) => {
      const user = await services.requireSession(request, reply);
      if (!user) return;
      try {
        await services.archiveConversation(user.id, request.params.conversationId);
        return reply.code(204).send();
      } catch (error) {
        return sendServiceError(error, reply);
      }
    },
  );

  app.post<{ Params: { conversationId: string } }>(
    "/v1/conversations/:conversationId/executions",
    async (request, reply) => {
      const user = await services.requireSession(request, reply);
      if (!user) return;
      const parsed = createExecutionSchema.safeParse(request.body);
      if (!parsed.success) return invalid(reply);
      try {
        const execution = await services.enqueueExecution({
          userId: user.id,
          conversationId: request.params.conversationId,
          requestKey: parsed.data.requestKey,
          leadAgentKey: parsed.data.leadAgentKey,
          text: parsed.data.text,
          attachments: parsed.data.attachments,
          model: parsed.data.model,
          autoApprovePermissions: parsed.data.autoApprovePermissions,
        });
        return reply.code(202).send({ executionId: execution.id });
      } catch (error) {
        return sendServiceError(error, reply);
      }
    },
  );

  app.post<{ Params: { executionId: string } }>(
    "/v1/executions/:executionId/abort",
    async (request, reply) => {
      const user = await services.requireSession(request, reply);
      if (!user) return;
      try {
        const execution = await services.abortExecution(user.id, request.params.executionId);
        return { status: execution.status.toLowerCase() };
      } catch (error) {
        return sendServiceError(error, reply);
      }
    },
  );

  app.post<{ Params: { executionId: string } }>(
    "/v1/executions/:executionId/reconcile",
    async (request, reply) => {
      const user = await services.requireSession(request, reply);
      if (!user) return;
      try {
        const execution = await services.reconcileInterruptedExecution(user.id, request.params.executionId);
        return { status: execution.status.toLowerCase(), error: execution.error };
      } catch (error) {
        return sendServiceError(error, reply);
      }
    },
  );

  app.post<{ Params: { executionId: string; requestId: string } }>(
    "/v1/executions/:executionId/questions/:requestId/reply",
    async (request, reply) => {
      const user = await services.requireSession(request, reply);
      if (!user) return;
      const parsed = questionReplySchema.safeParse(request.body);
      if (!parsed.success) return invalid(reply, "回答格式不正确");
      try {
        return await services.replyConversationQuestion(
          user.id,
          request.params.executionId,
          request.params.requestId,
          parsed.data.answers,
        );
      } catch (error) {
        return sendServiceError(error, reply);
      }
    },
  );

  app.post<{ Params: { executionId: string; requestId: string } }>(
    "/v1/executions/:executionId/permissions/:requestId/reply",
    async (request, reply) => {
      const user = await services.requireSession(request, reply);
      if (!user) return;
      const parsed = permissionReplySchema.safeParse(request.body);
      if (!parsed.success) return invalid(reply, "确认格式不正确");
      try {
        return await services.replyConversationPermission(
          user.id,
          request.params.executionId,
          request.params.requestId,
          parsed.data.response,
        );
      } catch (error) {
        return sendServiceError(error, reply);
      }
    },
  );
}
