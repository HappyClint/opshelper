import type { FastifyInstance } from "fastify";
import { Prisma } from "@prisma/client";
import { z } from "zod";

import {
  deleteContainerById,
  deleteContainerByUserId,
  fetchContainerLogs,
  getContainerById,
  getContainerByUserId,
  ensureContainerRecordForUser,
  recreateContainerRuntimeById,
  restartContainerById,
  restartContainerByUserId,
  startContainerByUserId,
  stopContainerById,
} from "../lib/container-service";
import {
  getAdminSnapshot,
  getUserPortalSnapshot,
  toContainerActionResponse,
} from "../lib/container-views";
import { getChatModels } from "../lib/admin-config-service";
import { requireAdmin, requireSession } from "../lib/session";
import {
  createUserAccount,
  deleteUserAccount,
  getAdminUsersSnapshot,
  getUserById,
  updateUserAccount,
  withAdminAccountMutation,
} from "../lib/user-service";
import { queueUserRuntimeConfiguration } from "../lib/runtime-configuration-service";
import { withUserConfigLock } from "../lib/user-config-lock";

const createUserSchema = z.object({
  username: z.string().trim().min(3).max(32),
  password: z.string().min(6),
  name: z.string().trim().max(64).optional(),
  role: z.enum(["user", "admin"]).optional(),
  isActive: z.boolean().optional(),
  keepContainerAlive: z.boolean().optional(),
});

const updateUserSchema = z
  .object({
    username: z.string().trim().min(3).max(32).optional(),
    password: z.string().min(6).optional(),
    name: z.string().trim().max(64).optional(),
    role: z.enum(["user", "admin"]).optional(),
    isActive: z.boolean().optional(),
    keepContainerAlive: z.boolean().optional(),
  })
  .refine(
    (input) =>
      input.username !== undefined ||
      input.password !== undefined ||
      input.name !== undefined ||
      input.role !== undefined ||
      input.isActive !== undefined ||
      input.keepContainerAlive !== undefined,
    {
      message: "At least one field must be updated",
    },
  );

export async function registerAppRoutes(app: FastifyInstance) {
  app.get("/v1/users/me/portal", async (request, reply) => {
    const user = await requireSession(request, reply);

    if (!user) {
      return;
    }

    return getUserPortalSnapshot(user.id);
  });

  // 聊天界面模型选择器的数据源：共享配置里管理员维护的自定义模型组（只含
  // id/显示名/完整引用，不下发 baseURL 与 apiKey）。模型是全局的，无按用户区分。
  app.get("/v1/users/me/models", async (request, reply) => {
    const user = await requireSession(request, reply);

    if (!user) {
      return;
    }

    return getChatModels();
  });

  app.post("/v1/users/me/container/start", async (request, reply) => {
    const user = await requireSession(request, reply);

    if (!user) {
      return;
    }

    const container = await startContainerByUserId(user.id);
    return toContainerActionResponse(container);
  });

  app.post("/v1/users/me/container/stop", async (request, reply) => {
    const user = await requireSession(request, reply);

    if (!user) {
      return;
    }

    const container = await getContainerByUserId(user.id);

    if (!container) {
      return reply.code(404).send({ message: "Container not found" });
    }

    const updated = await stopContainerById(container.id);
    return toContainerActionResponse(updated);
  });

  app.post("/v1/users/me/container/restart", async (request, reply) => {
    const user = await requireSession(request, reply);

    if (!user) {
      return;
    }

    const container = await restartContainerByUserId(user.id);

    if (!container) {
      return reply.code(404).send({ message: "Container not found" });
    }

    return toContainerActionResponse(container);
  });

  app.get<{
    Querystring: { tail?: string };
  }>("/v1/users/me/container/logs", async (request, reply) => {
    const user = await requireSession(request, reply);

    if (!user) {
      return;
    }

    const record = await getContainerByUserId(user.id);

    if (!record) {
      return reply.code(404).send({ message: "Container not found" });
    }

    const tail = Number.parseInt(request.query.tail ?? "200", 10);
    const logs = await fetchContainerLogs(record, Number.isFinite(tail) ? tail : 200);

    if (logs === null) {
      return reply.code(409).send({ message: "Container is not running yet" });
    }

    return { logs, tail: Number.isFinite(tail) ? tail : 200 };
  });

  app.delete("/v1/users/me/container", async (request, reply) => {
    const user = await requireSession(request, reply);

    if (!user) {
      return;
    }

    await deleteContainerByUserId(user.id);
    return toContainerActionResponse(null);
  });

  app.get("/v1/admin/overview", async (request, reply) => {
    const user = await requireAdmin(request, reply);

    if (!user) {
      return;
    }

    return getAdminSnapshot();
  });

  // -- Users --

  app.get<{
    Querystring: { q?: string };
  }>("/v1/admin/users", async (request, reply) => {
    const actor = await requireAdmin(request, reply);

    if (!actor) {
      return;
    }

    return getAdminUsersSnapshot(request.query.q ?? "");
  });

  app.post<{
    Params: { containerId: string };
  }>("/v1/admin/containers/:containerId/start", async (request, reply) => {
    const actor = await requireAdmin(request, reply);

    if (!actor) {
      return;
    }

    const container = await getContainerById(request.params.containerId);

    if (!container) {
      return reply.code(404).send({ message: "Container not found" });
    }

    const updated = await startContainerByUserId(container.userId);
    return toContainerActionResponse(updated);
  });

  app.post<{
    Params: { containerId: string };
  }>("/v1/admin/containers/:containerId/stop", async (request, reply) => {
    const actor = await requireAdmin(request, reply);

    if (!actor) {
      return;
    }

    const updated = await stopContainerById(request.params.containerId);

    if (!updated) {
      return reply.code(404).send({ message: "Container not found" });
    }

    return toContainerActionResponse(updated);
  });

  app.post<{
    Params: { containerId: string };
  }>("/v1/admin/containers/:containerId/restart", async (request, reply) => {
    const actor = await requireAdmin(request, reply);

    if (!actor) {
      return;
    }

    const updated = await restartContainerById(request.params.containerId);

    if (!updated) {
      return reply.code(404).send({ message: "Container not found" });
    }

    return toContainerActionResponse(updated);
  });

  app.post<{
    Params: { containerId: string };
  }>("/v1/admin/containers/:containerId/update-runtime", async (request, reply) => {
    const actor = await requireAdmin(request, reply);

    if (!actor) {
      return;
    }

    const updated = await recreateContainerRuntimeById(request.params.containerId);

    if (!updated) {
      return reply.code(404).send({ message: "Container not found" });
    }

    return toContainerActionResponse(updated);
  });

  app.get<{
    Params: { containerId: string };
    Querystring: { tail?: string };
  }>("/v1/admin/containers/:containerId/logs", async (request, reply) => {
    const actor = await requireAdmin(request, reply);

    if (!actor) {
      return;
    }

    const record = await getContainerById(request.params.containerId);

    if (!record) {
      return reply.code(404).send({ message: "Container not found" });
    }

    const tail = Number.parseInt(request.query.tail ?? "200", 10);
    const logs = await fetchContainerLogs(record, Number.isFinite(tail) ? tail : 200);

    if (logs === null) {
      return reply.code(409).send({ message: "Container is not running yet" });
    }

    return { logs, tail: Number.isFinite(tail) ? tail : 200 };
  });

  app.delete<{
    Params: { containerId: string };
  }>("/v1/admin/containers/:containerId", async (request, reply) => {
    const actor = await requireAdmin(request, reply);

    if (!actor) {
      return;
    }

    await deleteContainerById(request.params.containerId);
    return toContainerActionResponse(null);
  });

  app.get<{
    Params: { userId: string };
  }>("/v1/admin/users/:userId", async (request, reply) => {
    const actor = await requireAdmin(request, reply);

    if (!actor) {
      return;
    }

    const user = await getUserById(request.params.userId);

    if (!user) {
      return reply.code(404).send({ message: "User not found" });
    }

    return {
      user: {
        id: user.id,
        username: user.username,
        name: user.name,
        role: user.role === "ADMIN" ? "admin" : "user",
        isActive: user.isActive,
        keepContainerAlive: user.keepContainerAlive,
        createdAt: user.createdAt.toISOString(),
      },
    };
  });

  app.post("/v1/admin/users", async (request, reply) => {
    const actor = await requireAdmin(request, reply);

    if (!actor) {
      return;
    }

    const parsed = createUserSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid user payload" });
    }

    try {
      const user = await withAdminAccountMutation(actor.id, async () => {
        const created = await createUserAccount(parsed.data);
        await ensureContainerRecordForUser(created.id);
        return created;
      });
      return reply.code(201).send({ user });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return reply.code(409).send({ message: "账号已存在" });
      }

      if (error instanceof Error) {
        return reply.code(400).send({ message: error.message });
      }

      throw error;
    }
  });

  app.patch<{
    Params: { userId: string };
  }>("/v1/admin/users/:userId", async (request, reply) => {
    const actor = await requireAdmin(request, reply);

    if (!actor) {
      return;
    }

    const parsed = updateUserSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.code(400).send({ message: "Invalid user payload" });
    }

    try {
      const updateInput = {
        actorUserId: actor.id,
        userId: request.params.userId,
        ...parsed.data,
      };
      if (parsed.data.isActive !== undefined) {
        const existing = await getUserById(request.params.userId);
        if (!existing) return reply.code(404).send({ message: "User not found" });
        await ensureContainerRecordForUser(existing.id);
      }
      const user = await withAdminAccountMutation(actor.id, async () => parsed.data.isActive === undefined
        ? await updateUserAccount(updateInput)
        : await withUserConfigLock(request.params.userId, async (tx) => {
          const updated = await updateUserAccount(updateInput, tx);
          if (!updated) return null;
          await tx.containerInstance.update({
            where: { userId: request.params.userId },
            data: {
              desiredGeneration: { increment: 1 },
              desiredRuntimeHash: null,
              configApplyStatus: "REVOKING",
              configApplyAttemptId: null,
              configApplyError: parsed.data.isActive
                ? "用户已重新启用，正在恢复运行环境"
                : "用户已停用，正在关闭运行环境",
              drainingRuntimeState: [],
            },
          });
          if (!parsed.data.isActive) {
            await tx.schedule.updateMany({
              where: { userId: request.params.userId, status: "ACTIVE" },
              data: { status: "PAUSED", statusReason: "用户已停用" },
            });
            await tx.execution.updateMany({
              where: {
                userId: request.params.userId,
                status: "QUEUED",
                scheduleRunId: { not: null },
              },
              data: {
                status: "CANCELLED",
                error: "用户已停用",
                finishedAt: new Date(),
              },
            });
          }
          return updated;
        }));

      if (!user) {
        return reply.code(404).send({ message: "User not found" });
      }

      if (parsed.data.isActive !== undefined) queueUserRuntimeConfiguration(user.id);

      return { user };
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        return reply.code(409).send({ message: "账号已存在" });
      }

      if (error instanceof Error) {
        return reply.code(400).send({ message: error.message });
      }

      throw error;
    }
  });

  app.delete<{
    Params: { userId: string };
  }>("/v1/admin/users/:userId", async (request, reply) => {
    const actor = await requireAdmin(request, reply);

    if (!actor) {
      return;
    }

    try {
      const user = await withAdminAccountMutation(actor.id, () => deleteUserAccount({
        actorUserId: actor.id,
        userId: request.params.userId,
      }));

      if (!user) {
        return reply.code(404).send({ message: "User not found" });
      }

      return reply.code(204).send();
    } catch (error) {
      if (error instanceof Error) {
        return reply.code(400).send({ message: error.message });
      }

      throw error;
    }
  });
}
