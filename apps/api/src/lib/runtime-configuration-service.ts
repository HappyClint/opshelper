import { randomUUID } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { ContainerStatus, type Prisma } from "@prisma/client";
import { ContainerLifecycleLockError } from "./container-lifecycle";

import {
  discardContainerRuntimeByUserId,
  fetchActualBusinessAgentKeys,
  getActiveContainerRuntime,
  getContainerByUserId,
  getRuntimeWorkState,
  isContainerRuntimeRunning,
  recreateContainerRuntimeByUserId,
  stopContainerById,
} from "./container-service";
import { loadConfig } from "./config";
import { getUserPaths } from "./data-paths";
import { getAssignedRuntimeDefinition } from "./agent-service";
import { prepareManagedRuntime, readManagedRuntime } from "./managed-runtime";
import { prisma } from "./prisma";
import { withUserConfigLock } from "./user-config-lock";
import { abortExecution } from "./conversation-service";

const retryDelayMs = 2_000;
const scheduled = new Map<string, ReturnType<typeof setTimeout>>();

export interface DrainingRuntimeState {
  rootSessionIds: string[];
  activeSessionIds: string[];
  questionRequestIds: string[];
  permissionRequestIds: string[];
}

export interface RuntimeConfigurationApplyResult {
  status: "ready" | "draining" | "frozen" | "superseded";
  generation: number;
  error?: string;
}

function parseDrainingState(value: Prisma.JsonValue | null): DrainingRuntimeState | null {
  if (!value || Array.isArray(value) || typeof value !== "object") return null;
  const record = value as Record<string, Prisma.JsonValue>;
  const strings = (input: Prisma.JsonValue | undefined) => Array.isArray(input)
    ? input.filter((item): item is string => typeof item === "string")
    : [];
  return {
    rootSessionIds: strings(record.rootSessionIds),
    activeSessionIds: strings(record.activeSessionIds),
    questionRequestIds: strings(record.questionRequestIds),
    permissionRequestIds: strings(record.permissionRequestIds),
  };
}

async function cleanupReleases(userId: string, keepGeneration: string | null) {
  const releases = path.join(getUserPaths(userId, loadConfig()).managed, "releases");
  const entries = await readdir(releases, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === keepGeneration || entry.name.startsWith(".staging-")) continue;
    await rm(path.join(releases, entry.name), { recursive: true, force: true });
  }
}

async function attemptStillOwned(userId: string, generation: number, attemptId: string) {
  const record = await prisma.containerInstance.findUnique({
    where: { userId },
    select: { desiredGeneration: true, configApplyStatus: true, configApplyAttemptId: true },
  });
  return record?.desiredGeneration === generation &&
    record.configApplyStatus === "APPLYING" &&
    record.configApplyAttemptId === attemptId;
}

async function markAttemptFrozen(
  userId: string,
  generation: number,
  attemptId: string,
  error: unknown,
): Promise<RuntimeConfigurationApplyResult> {
  const message = error instanceof Error ? error.message : String(error);
  const updated = await prisma.containerInstance.updateMany({
    where: {
      userId,
      desiredGeneration: generation,
      configApplyStatus: "APPLYING",
      configApplyAttemptId: attemptId,
    },
    data: {
      configApplyStatus: "FROZEN",
      configApplyAttemptId: null,
      configApplyError: message,
    },
  });
  return updated.count === 1
    ? { status: "frozen", generation, error: message }
    : { status: "superseded", generation };
}

async function claimApply(userId: string) {
  return withUserConfigLock(userId, async (tx) => {
    const current = await tx.containerInstance.findUnique({
      where: { userId },
      include: { user: true },
    });
    if (!current) return { kind: "frozen", generation: 0, error: "用户固定运行环境不存在" } as const;
    const generation = current.desiredGeneration;
    if (current.configApplyStatus === "READY" && current.appliedGeneration === generation) {
      return { kind: "ready", generation } as const;
    }
    if (current.configApplyStatus === "FROZEN") {
      return { kind: "frozen", generation, error: current.configApplyError ?? "运行环境已冻结" } as const;
    }
    if (current.configApplyStatus === "APPLYING") {
      return { kind: "superseded", generation } as const;
    }

    // A formal top-level execution owns the user's runtime slot before any
    // external OpenCode call starts. Normal changes drain it; revocations ask
    // the execution service to stop and verify the whole native session tree.
    if (current.activeExecutionId) {
      return {
        kind: "execution",
        generation,
        executionId: current.activeExecutionId,
        revoking: current.configApplyStatus === "REVOKING",
      } as const;
    }

    const runtimeRunning = await isContainerRuntimeRunning(current);
    if (current.configApplyStatus === "DRAINING" && runtimeRunning) {
      let work;
      try {
        work = await getRuntimeWorkState(current);
      } catch (error) {
        const message = `无法确认当前任务是否结束：${error instanceof Error ? error.message : String(error)}`;
        await tx.containerInstance.updateMany({
          where: { userId, desiredGeneration: generation, configApplyStatus: "DRAINING" },
          data: { configApplyStatus: "FROZEN", configApplyError: message },
        });
        return { kind: "frozen", generation, error: message } as const;
      }
      const captured = parseDrainingState(current.drainingRuntimeState);
      const rootSessionIds = captured?.rootSessionIds.length
        ? captured.rootSessionIds
        : work.rootSessionIds;
      if (captured && work.rootSessionIds.some((id) => !rootSessionIds.includes(id))) {
        const message = "等待配置更新时出现了未捕获的新任务，会话归属无法安全确认";
        await tx.containerInstance.updateMany({
          where: { userId, desiredGeneration: generation, configApplyStatus: "DRAINING" },
          data: { configApplyStatus: "FROZEN", configApplyError: message },
        });
        return { kind: "frozen", generation, error: message } as const;
      }
      const drainingRuntimeState: DrainingRuntimeState = {
        rootSessionIds,
        activeSessionIds: work.activeSessionIds,
        questionRequestIds: work.questionRequestIds,
        permissionRequestIds: work.permissionRequestIds,
      };
      if (!work.idle) {
        await tx.containerInstance.updateMany({
          where: { userId, desiredGeneration: generation, configApplyStatus: "DRAINING" },
          data: { drainingRuntimeState: drainingRuntimeState as unknown as Prisma.InputJsonObject },
        });
        return { kind: "draining", generation } as const;
      }
    }

    const attemptId = randomUUID();
    const claimed = await tx.containerInstance.updateMany({
      where: {
        userId,
        desiredGeneration: generation,
        configApplyStatus: { in: ["DRAINING", "REVOKING"] },
      },
      data: {
        configApplyStatus: "APPLYING",
        configApplyAttemptId: attemptId,
        configApplyError: null,
      },
    });
    return claimed.count === 1
      ? { kind: "claimed", generation, attemptId, runtimeRunning, userActive: current.user.isActive } as const
      : { kind: "superseded", generation } as const;
  });
}

export async function applyUserRuntimeConfiguration(
  userId: string,
): Promise<RuntimeConfigurationApplyResult> {
  const claim = await claimApply(userId);
  if (claim.kind === "ready") return { status: "ready", generation: claim.generation };
  if (claim.kind === "draining") return { status: "draining", generation: claim.generation };
  if (claim.kind === "execution") {
    if (claim.revoking) {
      const stopped = await abortExecution(userId, claim.executionId);
      if (stopped.status === "INTERRUPTED") {
        const error = stopped.error ?? "撤销智能体时无法确认当前执行已经停止";
        await prisma.containerInstance.updateMany({
          where: { userId, desiredGeneration: claim.generation, configApplyStatus: "REVOKING" },
          data: { configApplyStatus: "FROZEN", configApplyError: error },
        });
        return { status: "frozen", generation: claim.generation, error };
      }
      queueUserRuntimeConfiguration(userId, retryDelayMs);
    }
    return { status: "draining", generation: claim.generation };
  }
  if (claim.kind === "frozen") return { status: "frozen", generation: claim.generation, error: claim.error };
  if (claim.kind === "superseded") return { status: "superseded", generation: claim.generation };

  const { generation, attemptId, runtimeRunning, userActive } = claim;
  try {
    if (!userActive) {
      await discardContainerRuntimeByUserId(userId);
      if (await isContainerRuntimeRunning((await getContainerByUserId(userId))!)) {
        throw new Error("停用用户的旧运行环境仍在运行");
      }
      await cleanupReleases(userId, null);
      return markAttemptFrozen(userId, generation, attemptId, new Error("用户已停用，运行环境保持关闭"));
    }

    const definition = await getAssignedRuntimeDefinition(userId);
    if (definition.desiredGeneration !== generation) {
      return { status: "superseded", generation };
    }
    const expectedAgentKeys = definition.agents.map((agent) => agent.key).sort();
    let runtimeHash: string | null = null;

    if (!expectedAgentKeys.length) {
      await discardContainerRuntimeByUserId(userId);
      const latest = await getContainerByUserId(userId);
      if (latest && await isContainerRuntimeRunning(latest)) throw new Error("旧运行环境未能停止");
    } else {
      const runtime = await prepareManagedRuntime(userId);
      if (runtime.desiredGeneration !== generation) return { status: "superseded", generation };
      runtimeHash = runtime.generation;
      if (!await attemptStillOwned(userId, generation, attemptId)) {
        return { status: "superseded", generation };
      }
      const running = await recreateContainerRuntimeByUserId(userId, runtime);
      const activeRuntime = await getActiveContainerRuntime(running);
      const actualAgentKeys = await fetchActualBusinessAgentKeys(running);
      if (activeRuntime.generation !== runtime.generation) {
        throw new Error("容器标签与目标配置代次不一致");
      }
      if (
        actualAgentKeys.length !== expectedAgentKeys.length ||
        actualAgentKeys.some((key, index) => key !== expectedAgentKeys[index])
      ) {
        throw new Error(`装配核验失败：期望 ${expectedAgentKeys.join(", ")}，实际 ${actualAgentKeys.join(", ")}`);
      }
      if (!runtimeRunning) await stopContainerById(running.id);
    }

    const completed = await prisma.containerInstance.updateMany({
      where: {
        userId,
        desiredGeneration: generation,
        configApplyStatus: "APPLYING",
        configApplyAttemptId: attemptId,
      },
      data: {
        appliedGeneration: generation,
        desiredRuntimeHash: runtimeHash,
        appliedRuntimeHash: runtimeHash,
        configApplyStatus: "READY",
        configApplyAttemptId: null,
        configApplyError: null,
        drainingRuntimeState: [],
        configAppliedAt: new Date(),
      },
    });
    if (completed.count !== 1) return { status: "superseded", generation };

    await withUserConfigLock(userId, async (tx) => {
      const current = await tx.containerInstance.findUnique({ where: { userId } });
      if (
        current?.configApplyStatus === "READY" &&
        current.desiredGeneration === generation &&
        current.appliedRuntimeHash === runtimeHash
      ) {
        await cleanupReleases(userId, runtimeHash);
      }
    });
    return { status: "ready", generation };
  } catch (error) {
    if (error instanceof ContainerLifecycleLockError) {
      const released = await prisma.containerInstance.updateMany({
        where: {
          userId,
          desiredGeneration: generation,
          configApplyStatus: "APPLYING",
          configApplyAttemptId: attemptId,
        },
        data: { configApplyStatus: "REVOKING", configApplyAttemptId: null },
      });
      if (released.count === 1) queueUserRuntimeConfiguration(userId, retryDelayMs);
      return { status: "superseded", generation };
    }
    if (await attemptStillOwned(userId, generation, attemptId)) {
      await discardContainerRuntimeByUserId(userId).catch(() => undefined);
    }
    return markAttemptFrozen(userId, generation, attemptId, error);
  }
}

export function queueUserRuntimeConfiguration(userId: string, delayMs = 0) {
  if (scheduled.has(userId)) return;
  const timer = setTimeout(() => {
    scheduled.delete(userId);
    applyUserRuntimeConfiguration(userId)
      .then(async (result) => {
        if (result.status === "draining" || result.status === "superseded") {
          const current = await prisma.containerInstance.findUnique({
            where: { userId },
            select: { configApplyStatus: true },
          });
          if (current && ["DRAINING", "REVOKING"].includes(current.configApplyStatus)) {
            queueUserRuntimeConfiguration(userId, retryDelayMs);
          }
        }
      })
      .catch(async () => {
        const current = await prisma.containerInstance.findUnique({
          where: { userId },
          select: { configApplyStatus: true },
        }).catch(() => null);
        if (current && ["DRAINING", "REVOKING"].includes(current.configApplyStatus)) {
          queueUserRuntimeConfiguration(userId, retryDelayMs);
        }
      });
  }, delayMs);
  timer.unref?.();
  scheduled.set(userId, timer);
}

export async function markUserRuntimeRevoking(userId: string, reason?: string) {
  await prisma.containerInstance.updateMany({
    where: { userId },
    data: {
      desiredGeneration: { increment: 1 },
      desiredRuntimeHash: null,
      configApplyStatus: "REVOKING",
      configApplyAttemptId: null,
      configApplyError: reason ?? null,
      drainingRuntimeState: [],
    },
  });
  queueUserRuntimeConfiguration(userId);
}

export async function reconcileUserRuntimeConfiguration(userId: string) {
  await withUserConfigLock(userId, (tx) => tx.containerInstance.updateMany({
      where: { userId },
      data: {
        desiredGeneration: { increment: 1 },
        desiredRuntimeHash: null,
        configApplyStatus: "REVOKING",
        configApplyAttemptId: null,
        configApplyError: null,
        drainingRuntimeState: [],
      },
    }));
  return applyUserRuntimeConfiguration(userId);
}

export async function resumeRuntimeConfigurationApplications() {
  const interrupted = await prisma.containerInstance.updateMany({
    where: { configApplyStatus: "APPLYING" },
    data: {
      configApplyStatus: "FROZEN",
      configApplyAttemptId: null,
      configApplyError: "上次配置装配在服务重启前未完成，请由管理员重新装配",
    },
  });
  const pending = await prisma.containerInstance.findMany({
    where: { configApplyStatus: { in: ["DRAINING", "REVOKING"] }, user: { isActive: true } },
    select: { userId: true },
  });
  for (const { userId } of pending) queueUserRuntimeConfiguration(userId);
  return { resumed: pending.length, frozen: interrupted.count };
}

export async function getUserRuntimeConfiguration(userId: string) {
  const record = await prisma.containerInstance.findUnique({
    where: { userId },
    include: { user: true },
  });
  if (!record) return null;
  const assignments = await prisma.userAgent.findMany({
    where: { userId },
    include: { agent: true },
  });
  const expectedAgentKeys = assignments
    .filter((entry) => entry.agent.isEnabled && entry.agent.checkStatus === "READY")
    .map((entry) => entry.agent.key)
    .sort();
  let actualAgentKeys: string[] = [];
  if (record.status === ContainerStatus.RUNNING) {
    actualAgentKeys = await fetchActualBusinessAgentKeys(record).catch(() => []);
  } else if (record.appliedRuntimeHash) {
    actualAgentKeys = await readManagedRuntime(userId, record.appliedRuntimeHash)
      .then((runtime) => runtime.agentKeys)
      .catch(() => []);
  }
  return {
    record,
    expectedAgentKeys,
    actualAgentKeys,
    drainingRuntimeState: parseDrainingState(record.drainingRuntimeState),
  };
}
