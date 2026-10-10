import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import {
  AdminConfigError,
  getGlobalInstructions,
  getModelSettings,
  MAX_GLOBAL_INSTRUCTIONS_BYTES,
  updateGlobalInstructions,
  updateModelSettings,
} from "../lib/admin-config-service";
import { prisma } from "../lib/prisma";
import { queueUserRuntimeConfiguration } from "../lib/runtime-configuration-service";
import { requireAdmin } from "../lib/session";
import { withUserConfigLocks } from "../lib/user-config-lock";

const modelSettingsBodySchema = z.object({
  baseURL: z.string().max(2048).optional().default(""),
  apiKey: z.string().max(4096).optional().default(""),
  models: z.array(z.object({
    id: z.string().min(1).max(128),
    name: z.string().max(128).optional().default(""),
  })).max(100).optional().default([]),
  defaultModel: z.string().max(160).optional().default(""),
}).strict();

const globalInstructionsBodySchema = z.object({
  content: z.string(),
}).strict();

function handleError(error: unknown, reply: FastifyReply) {
  if (error instanceof AdminConfigError) {
    return reply.code(error.statusCode).send({ message: error.message });
  }
  throw error;
}

/**
 * Platform model and global instruction settings are shared. Agent-specific
 * content comes from data/agents and is projected into each user's environment.
 */
export async function registerAdminConfigRoutes(app: FastifyInstance) {
  app.get("/v1/admin/opencode/models", async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    try {
      return await getModelSettings();
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.put("/v1/admin/opencode/models", async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    const parsed = modelSettingsBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "请求参数不合法" });
    const users = await prisma.containerInstance.findMany({ select: { userId: true } });
    const userIds = users.map((entry) => entry.userId);
    try {
      const settings = await withUserConfigLocks(userIds, async () => {
        const updated = await updateModelSettings(parsed.data);
        await prisma.containerInstance.updateMany({
          where: { userId: { in: userIds } },
          data: {
            desiredGeneration: { increment: 1 },
            desiredRuntimeHash: null,
            configApplyStatus: "DRAINING",
            configApplyError: null,
          },
        });
        return updated;
      });
      for (const userId of userIds) queueUserRuntimeConfiguration(userId);
      return { success: true, ...settings };
    } catch (error) {
      return handleError(error, reply);
    }
  });

  app.get("/v1/admin/opencode/instructions", async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    return {
      content: await getGlobalInstructions(),
      maxBytes: MAX_GLOBAL_INSTRUCTIONS_BYTES,
    };
  });

  app.put("/v1/admin/opencode/instructions", async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    const parsed = globalInstructionsBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "请求参数不合法" });
    const users = await prisma.containerInstance.findMany({ select: { userId: true } });
    const userIds = users.map((entry) => entry.userId);
    try {
      const content = await withUserConfigLocks(userIds, async () => {
        const updated = await updateGlobalInstructions(parsed.data.content);
        await prisma.containerInstance.updateMany({
          where: { userId: { in: userIds } },
          data: {
            desiredGeneration: { increment: 1 },
            desiredRuntimeHash: null,
            configApplyStatus: "DRAINING",
            configApplyError: null,
          },
        });
        return updated;
      });
      for (const userId of userIds) queueUserRuntimeConfiguration(userId);
      return { success: true, content, maxBytes: MAX_GLOBAL_INSTRUCTIONS_BYTES };
    } catch (error) {
      return handleError(error, reply);
    }
  });
}
