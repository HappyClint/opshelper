import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import type { ScheduleInput } from "@opshelper/shared";

import {
  ScheduleServiceError,
  createSchedule,
  deleteSchedule,
  getSchedule,
  getScheduleRunAnswer,
  listSchedules,
  pauseSchedule,
  resumeSchedule,
  runScheduleNow,
  updateSchedule,
} from "../lib/schedule-service";
import { requireSession } from "../lib/session";

const attachment = z.object({
  path: z.string().min(1).max(1024),
  filename: z.string().min(1).max(255),
  mime: z.string().min(1).max(255),
}).strict();
const rule = z.discriminatedUnion("frequency", [
  z.object({
    frequency: z.literal("once"),
    localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    localTime: z.string().regex(/^\d{2}:\d{2}$/),
  }).strict(),
  z.object({
    frequency: z.literal("daily"),
    localTime: z.string().regex(/^\d{2}:\d{2}$/),
  }).strict(),
  z.object({
    frequency: z.literal("weekly"),
    weekday: z.number().int().min(1).max(7),
    localTime: z.string().regex(/^\d{2}:\d{2}$/),
  }).strict(),
  z.object({
    frequency: z.literal("cron"),
    cronExpression: z.string().trim().min(1).max(255),
  }).strict(),
]);
const scheduleInput = z.object({
  name: z.string().trim().min(1).max(120),
  prompt: z.string().trim().min(1).max(50_000),
  leadAgentKey: z.string().trim().min(1).max(64),
  participantAgentKeys: z.array(z.string().trim().min(1).max(64)).max(24).default([]),
  attachments: z.array(attachment).max(20).default([]),
  model: z.string().trim().max(256).optional(),
  autoApprovePermissions: z.boolean().default(false),
  rule,
}).strict();
const runInput = z.object({ requestKey: z.string().trim().min(8).max(200) }).strict();

function handleScheduleError(reply: FastifyReply, error: unknown) {
  if (error instanceof ScheduleServiceError) {
    return reply.code(error.statusCode).send({ message: error.message });
  }
  throw error;
}

export interface ScheduleRouteServices {
  requireSession: typeof requireSession;
  listSchedules: typeof listSchedules;
  getSchedule: typeof getSchedule;
  getScheduleRunAnswer: typeof getScheduleRunAnswer;
  createSchedule: typeof createSchedule;
  updateSchedule: typeof updateSchedule;
  deleteSchedule: typeof deleteSchedule;
  pauseSchedule: typeof pauseSchedule;
  resumeSchedule: typeof resumeSchedule;
  runScheduleNow: typeof runScheduleNow;
}

const defaultServices: ScheduleRouteServices = {
  requireSession,
  listSchedules,
  getSchedule,
  getScheduleRunAnswer,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  pauseSchedule,
  resumeSchedule,
  runScheduleNow,
};

export async function registerScheduleRoutes(
  app: FastifyInstance,
  services: ScheduleRouteServices = defaultServices,
) {
  app.get("/v1/me/schedules", async (request, reply) => {
    const user = await services.requireSession(request, reply);
    if (!user) return;
    return services.listSchedules(user.id);
  });

  app.post("/v1/me/schedules", async (request, reply) => {
    const user = await services.requireSession(request, reply);
    if (!user) return;
    const parsed = scheduleInput.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "定时任务内容不完整" });
    try {
      return reply.code(201).send(
        await services.createSchedule(user.id, parsed.data as ScheduleInput),
      );
    } catch (error) {
      return handleScheduleError(reply, error);
    }
  });

  app.get<{ Params: { scheduleId: string } }>(
    "/v1/me/schedules/:scheduleId",
    async (request, reply) => {
      const user = await services.requireSession(request, reply);
      if (!user) return;
      try {
        return await services.getSchedule(user.id, request.params.scheduleId);
      } catch (error) {
        return handleScheduleError(reply, error);
      }
    },
  );

  app.put<{ Params: { scheduleId: string } }>(
    "/v1/me/schedules/:scheduleId",
    async (request, reply) => {
      const user = await services.requireSession(request, reply);
      if (!user) return;
      const parsed = scheduleInput.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ message: "定时任务内容不完整" });
      try {
        return await services.updateSchedule(
          user.id,
          request.params.scheduleId,
          parsed.data as ScheduleInput,
        );
      } catch (error) {
        return handleScheduleError(reply, error);
      }
    },
  );

  app.delete<{ Params: { scheduleId: string } }>(
    "/v1/me/schedules/:scheduleId",
    async (request, reply) => {
      const user = await services.requireSession(request, reply);
      if (!user) return;
      try {
        await services.deleteSchedule(user.id, request.params.scheduleId);
        return reply.code(204).send();
      } catch (error) {
        return handleScheduleError(reply, error);
      }
    },
  );

  for (const [action, service] of [
    ["pause", services.pauseSchedule],
    ["resume", services.resumeSchedule],
  ] as const) {
    app.post<{ Params: { scheduleId: string } }>(
      `/v1/me/schedules/:scheduleId/${action}`,
      async (request, reply) => {
        const user = await services.requireSession(request, reply);
        if (!user) return;
        try {
          return await service(user.id, request.params.scheduleId);
        } catch (error) {
          return handleScheduleError(reply, error);
        }
      },
    );
  }

  app.get<{ Params: { scheduleId: string; runId: string } }>(
    "/v1/me/schedules/:scheduleId/runs/:runId/answer",
    async (request, reply) => {
      const user = await services.requireSession(request, reply);
      if (!user) return;
      try {
        return await services.getScheduleRunAnswer(
          user.id,
          request.params.scheduleId,
          request.params.runId,
        );
      } catch (error) {
        return handleScheduleError(reply, error);
      }
    },
  );

  app.post<{ Params: { scheduleId: string } }>(
    "/v1/me/schedules/:scheduleId/runs",
    async (request, reply) => {
      const user = await services.requireSession(request, reply);
      if (!user) return;
      const parsed = runInput.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ message: "运行请求标识不正确" });
      try {
        return reply.code(202).send(
          await services.runScheduleNow(user.id, request.params.scheduleId, parsed.data.requestKey),
        );
      } catch (error) {
        return handleScheduleError(reply, error);
      }
    },
  );
}
