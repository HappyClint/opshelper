import type { FastifyInstance, FastifyReply } from "fastify";
import { Prisma } from "@prisma/client";
import type { AgentMode } from "@opshelper/shared";
import { z } from "zod";

import {
  AgentServiceError,
  checkAgent,
  createAgent,
  deleteAgent,
  getAgent,
  listUserAgentAssignments,
  replaceUserAgentAssignments,
  setAgentEnabled,
  updateAgent,
} from "../lib/agent-service";
import { ensureContainerRecordForUser } from "../lib/container-service";
import { prisma } from "../lib/prisma";
import {
  applyUserRuntimeConfiguration,
  getUserRuntimeConfiguration,
  queueUserRuntimeConfiguration,
  reconcileUserRuntimeConfiguration,
} from "../lib/runtime-configuration-service";
import { requireAdmin, requireSession } from "../lib/session";
import { pauseInvalidSchedulesForUser } from "../lib/schedule-service";
import { importSkillPackage, isUtf8Text } from "../lib/skill-package";
import { ZipError } from "../lib/zip";
import { withAgentConfigLocks, withUserConfigLock, withUserConfigLocks } from "../lib/user-config-lock";

const filesSchema = z.record(z.string().min(1).max(220), z.string().max(16 * 1024 * 1024));
const binaryFilesSchema = z.record(z.string().min(1).max(220), z.string().max(24 * 1024 * 1024)).optional().default({});
const createSchema = z.object({
  key: z.string().trim().min(1).max(64),
  files: filesSchema,
  binaryFiles: binaryFilesSchema,
}).strict();
const patchSchema = z.union([
  z.object({ files: filesSchema, binaryFiles: binaryFilesSchema }).strict(),
  z.object({ isEnabled: z.boolean() }).strict(),
]);
const assignmentsSchema = z.object({
  agentIds: z.array(z.string().min(1)).max(32),
  expectedDesiredGeneration: z.number().int().nonnegative(),
}).strict();

function statusCodeOf(error: unknown) {
  if (error instanceof AgentServiceError) return error.statusCode;
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") return 409;
  return null;
}

function handleAgentError(reply: FastifyReply, error: unknown) {
  if (error instanceof ZipError) return reply.code(400).send({ message: error.message });
  const statusCode = statusCodeOf(error);
  if (statusCode && error instanceof Error) {
    return reply.code(statusCode).send({ message: error.message });
  }
  throw error;
}

function serializeAgent(record: {
  id: string;
  key: string;
  displayName: string;
  description: string;
  mode: string;
  isEnabled: boolean;
  contentHash: string | null;
  checkStatus: "PENDING" | "READY" | "ERROR";
  checkError: string | null;
  checkedAt: Date | null;
  _count?: { users: number };
}) {
  return {
    id: record.id,
    key: record.key,
    displayName: record.displayName,
    description: record.description,
    mode: record.mode as AgentMode,
    isEnabled: record.isEnabled,
    contentHash: record.contentHash,
    checkStatus: record.checkStatus.toLowerCase(),
    checkError: record.checkError,
    checkedAt: record.checkedAt?.toISOString() ?? null,
    assignmentCount: record._count?.users ?? 0,
  };
}

async function listAgentSummaries() {
  const agents = await prisma.agent.findMany({
    include: { _count: { select: { users: true } } },
    orderBy: { key: "asc" },
  });
  return agents.map(serializeAgent);
}

function decodeDirectoryFiles(input: { files: Record<string, string>; binaryFiles?: Record<string, string> }) {
  const files: Record<string, string | Uint8Array> = { ...input.files };
  for (const [name, encoded] of Object.entries(input.binaryFiles ?? {})) {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw new AgentServiceError(`二进制文件不是合法 Base64：${name}`);
    }
    files[name] = Buffer.from(encoded, "base64");
  }
  return files;
}

async function serializeAgentDetail(key: string) {
  const [detail, record] = await Promise.all([
    getAgent(key),
    prisma.agent.findUniqueOrThrow({
      where: { key },
      include: { _count: { select: { users: true } } },
    }),
  ]);
  const files: Record<string, string> = {};
  const binaryFiles: Record<string, string> = {};
  for (const [name, encoded] of Object.entries(detail.filesBase64 ?? {})) {
    const content = Buffer.from(encoded, "base64");
    if (isUtf8Text(content)) files[name] = content.toString("utf8");
    else binaryFiles[name] = encoded;
  }
  return { ...serializeAgent(record), files, binaryFiles };
}

async function affectedUserIds(key: string) {
  return prisma.userAgent.findMany({
    where: { agent: { key } },
    select: { userId: true },
    orderBy: { userId: "asc" },
  }).then((items) => items.map((item) => item.userId));
}

async function agentIdForKey(key: string) {
  const agent = await prisma.agent.findUnique({ where: { key }, select: { id: true } });
  if (!agent) throw new AgentServiceError("Agent 不存在", 404);
  return agent.id;
}

export interface AgentDeleteRouteServices {
  requireAdmin: typeof requireAdmin;
  resolveAgentId: (key: string) => Promise<string>;
  withAgentLocks: <T>(agentIds: string[], callback: () => Promise<T>) => Promise<T>;
  deleteAgent: (key: string) => Promise<unknown>;
}

const defaultAgentDeleteRouteServices: AgentDeleteRouteServices = {
  requireAdmin,
  resolveAgentId: agentIdForKey,
  withAgentLocks: withAgentConfigLocks,
  deleteAgent,
};

export function registerAgentDeleteRoute(
  app: FastifyInstance,
  services: AgentDeleteRouteServices = defaultAgentDeleteRouteServices,
) {
  app.delete<{ Params: { key: string } }>("/v1/admin/agents/:key", async (request, reply) => {
    if (!await services.requireAdmin(request, reply)) return;
    try {
      const agentId = await services.resolveAgentId(request.params.key);
      await services.withAgentLocks(
        [agentId],
        () => services.deleteAgent(request.params.key),
      );
      return reply.code(204).send();
    } catch (error) {
      return handleAgentError(reply, error);
    }
  });
}

async function buildUserAssignmentSnapshot(userId: string) {
  await ensureContainerRecordForUser(userId);
  const [user, assigned, agents, configuration] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId } }),
    listUserAgentAssignments(userId),
    listAgentSummaries(),
    getUserRuntimeConfiguration(userId),
  ]);
  if (!user || !configuration) throw new AgentServiceError("用户不存在", 404);
  const state = configuration.record.configApplyStatus.toLowerCase() as
    | "draining"
    | "revoking"
    | "applying"
    | "ready"
    | "frozen";
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
    assignedAgentIds: assigned.map((entry) => entry.agentId),
    agents,
    configuration: {
      status: state,
      desiredGeneration: configuration.record.desiredGeneration,
      appliedGeneration: configuration.record.appliedGeneration,
      expectedAgentKeys: configuration.expectedAgentKeys,
      actualAgentKeys: configuration.actualAgentKeys,
      desiredRuntimeHash: configuration.record.desiredRuntimeHash,
      appliedRuntimeHash: configuration.record.appliedRuntimeHash,
      error: configuration.record.configApplyError,
      action: state === "frozen" ? "retry" : state === "ready" ? "none" : "wait",
    },
  };
}

export async function registerAgentRoutes(app: FastifyInstance) {
  app.get("/v1/admin/agents", async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    return { agents: await listAgentSummaries() };
  });

  app.get<{ Params: { key: string } }>("/v1/admin/agents/:key", async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    try {
      return { agent: await serializeAgentDetail(request.params.key) };
    } catch (error) {
      return handleAgentError(reply, error);
    }
  });

  app.post("/v1/admin/agents/skill-package", async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    try {
      const upload = await request.file();
      if (!upload) return reply.code(400).send({ message: "请选择 ZIP 技能包" });
      if (!upload.filename.toLowerCase().endsWith(".zip")) {
        return reply.code(400).send({ message: "技能包必须是 .zip 文件" });
      }
      return importSkillPackage(await upload.toBuffer());
    } catch (error) {
      return handleAgentError(reply, error);
    }
  });

  app.post("/v1/admin/agents", { bodyLimit: 90 * 1024 * 1024 }, async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "智能体目录内容不完整" });
    try {
      await createAgent({ key: parsed.data.key, files: decodeDirectoryFiles(parsed.data) });
      return reply.code(201).send({ agent: await serializeAgentDetail(parsed.data.key) });
    } catch (error) {
      return handleAgentError(reply, error);
    }
  });

  app.patch<{ Params: { key: string } }>("/v1/admin/agents/:key", { bodyLimit: 90 * 1024 * 1024 }, async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    const parsed = patchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "修改内容不正确" });
    try {
      const agentId = await agentIdForKey(request.params.key);
      const users = await withAgentConfigLocks([agentId], async () => {
        const lockedUsers = await affectedUserIds(request.params.key);
        await withUserConfigLocks(lockedUsers, async () => {
          if ("files" in parsed.data) await updateAgent(request.params.key, { files: decodeDirectoryFiles(parsed.data) });
          else await setAgentEnabled(request.params.key, parsed.data.isEnabled);
        });
        return lockedUsers;
      });
      for (const userId of users) {
        await pauseInvalidSchedulesForUser(userId);
        queueUserRuntimeConfiguration(userId);
      }
      return { agent: await serializeAgentDetail(request.params.key) };
    } catch (error) {
      return handleAgentError(reply, error);
    }
  });

  app.post<{ Params: { key: string } }>("/v1/admin/agents/:key/check", async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    let users: string[] = [];
    try {
      const agentId = await agentIdForKey(request.params.key);
      await withAgentConfigLocks([agentId], async () => {
        users = await affectedUserIds(request.params.key);
        await withUserConfigLocks(users, () => checkAgent(request.params.key));
      });
      for (const userId of users) {
        await pauseInvalidSchedulesForUser(userId);
        queueUserRuntimeConfiguration(userId);
      }
      return { agent: await serializeAgentDetail(request.params.key) };
    } catch (error) {
      for (const userId of users) {
        await pauseInvalidSchedulesForUser(userId).catch(() => undefined);
        queueUserRuntimeConfiguration(userId);
      }
      return handleAgentError(reply, error);
    }
  });

  registerAgentDeleteRoute(app);

  app.get<{ Params: { userId: string } }>("/v1/admin/users/:userId/agents", async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    try {
      return await buildUserAssignmentSnapshot(request.params.userId);
    } catch (error) {
      return handleAgentError(reply, error);
    }
  });

  app.put<{ Params: { userId: string } }>("/v1/admin/users/:userId/agents", async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    const parsed = assignmentsSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ message: "分配清单不正确" });
    try {
      await ensureContainerRecordForUser(request.params.userId);
      const currentAssignments = await prisma.userAgent.findMany({
        where: { userId: request.params.userId },
        select: { agentId: true },
      });
      await withAgentConfigLocks([
        ...currentAssignments.map((entry) => entry.agentId),
        ...parsed.data.agentIds,
      ], () => withUserConfigLock(request.params.userId, async (tx) => {
          const current = await tx.containerInstance.findUnique({
            where: { userId: request.params.userId },
            select: { desiredGeneration: true },
          });
          if (!current) throw new AgentServiceError("用户固定运行环境不存在", 409);
          if (current.desiredGeneration !== parsed.data.expectedDesiredGeneration) {
            throw new AgentServiceError("分配状态已变化，请刷新后重试", 409);
          }
          await replaceUserAgentAssignments(request.params.userId, parsed.data.agentIds);
          await pauseInvalidSchedulesForUser(request.params.userId);
        }));
      await applyUserRuntimeConfiguration(request.params.userId);
      return await buildUserAssignmentSnapshot(request.params.userId);
    } catch (error) {
      return handleAgentError(reply, error);
    }
  });

  app.post<{ Params: { userId: string } }>("/v1/admin/users/:userId/agents/reconcile", async (request, reply) => {
    if (!await requireAdmin(request, reply)) return;
    try {
      await reconcileUserRuntimeConfiguration(request.params.userId);
      return await buildUserAssignmentSnapshot(request.params.userId);
    } catch (error) {
      return handleAgentError(reply, error);
    }
  });

  app.get("/v1/users/me/agents", async (request, reply) => {
    const user = await requireSession(request, reply);
    if (!user) return;
    const configuration = await getUserRuntimeConfiguration(user.id);
    if (!configuration || configuration.record.configApplyStatus !== "READY") {
      return reply.code(503).send({ message: configuration?.record.configApplyError ?? "运行环境尚未就绪" });
    }
    const assigned = await listUserAgentAssignments(user.id);
    return {
      agents: assigned
        .filter((entry) => entry.agent.isEnabled && configuration.actualAgentKeys.includes(entry.agent.key))
        .map((entry) => ({
          id: entry.agent.id,
          key: entry.agent.key,
          displayName: entry.agent.displayName,
          description: entry.agent.description,
        })),
    };
  });
}
