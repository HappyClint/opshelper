import Docker from "dockerode";
import { isDockerNotFound, stopDockerContainerIfRunning as stopRuntimeIfRunning } from "@opshelper/shared";
import { randomUUID } from "node:crypto";
import {
  ContainerStatus,
  Prisma,
  type ContainerInstance,
  type User,
} from "@prisma/client";

import {
  ContainerLifecycleLockError,
  WakeAttemptCoolingDownError,
  isLifecycleLockExpired,
  isWakeAttemptCoolingDown,
  lifecycleLockTtlMs,
  startContainerIfNeeded,
} from "./container-lifecycle";
import { buildContainerCreateOptions, isStaleRuntime } from "./opencode-container-runtime";
import { getRuntimePassword, prepareManagedRuntime, readManagedRuntime, runtimeAuthorization, type ManagedRuntime } from "./managed-runtime";
import { loadConfig } from "./config";
import { prisma } from "./prisma";
import { type ContainerWithUser } from "./serializers";

const config = loadConfig();
const docker = new Docker({
  socketPath: config.dockerSocketPath,
});

const proxyActivityThrottleMs = 60 * 1000;
const lifecycleWaitTimeoutMs = 45 * 1000;
const lifecycleWaitIntervalMs = 1000;

type StartContainerOptions = {
  lockOwner?: string;
  waitForExisting?: boolean;
};

export class RuntimeConfigurationUnavailableError extends Error {
  statusCode = 503;
  constructor(message = "用户运行环境正在更新，请稍后再试") {
    super(message);
  }
}

function assertExecutionIdle(record: Pick<ContainerInstance, "activeExecutionId" | "executionRecoveryRequired" | "executionRecoveryReason">) {
  if (record.activeExecutionId || record.executionRecoveryRequired) {
    throw new RuntimeConfigurationUnavailableError(
      record.executionRecoveryReason ?? "当前有执行正在运行或等待恢复，不能变更用户运行环境",
    );
  }
}

function buildContainerMeta(user: User) {
  // Stable user ID avoids collisions between normalized usernames.
  const slug = user.id;

  return {
    name: `opshelper-user-${slug}`,
    proxySlug: user.id,
  };
}

async function ensureNetwork() {
  try {
    await docker.getNetwork(config.dockerNetwork).inspect();
  } catch {
    await docker.createNetwork({
      Name: config.dockerNetwork,
      CheckDuplicate: true,
    });
  }
}

async function resolveDockerContainer(record: ContainerInstance) {
  const byName = docker.getContainer(record.name);

  try {
    const info = await byName.inspect();
    if (info.Config.Labels["opshelper.userId"] !== record.userId || info.Config.Labels["opshelper.managed"] !== "true") {
      throw new Error("Container ownership mismatch");
    }
    return byName;
  } catch (error) {
    if (!isDockerNotFound(error)) throw error;
    if (!record.dockerContainerId) {
      return null;
    }
  }

  try {
    const byId = docker.getContainer(record.dockerContainerId);
    const info = await byId.inspect();
    if (info.Config.Labels["opshelper.userId"] !== record.userId || info.Config.Labels["opshelper.managed"] !== "true") {
      throw new Error("Container ownership mismatch");
    }
    return byId;
  } catch (error) {
    if (!isDockerNotFound(error)) throw error;
    return null;
  }
}

/**
 * Resolve an image tag (e.g. `opshelper/opencode-runtime:latest`) to the image ID it
 * currently points at. Returns null when the tag isn't present locally — callers
 * treat that as "can't tell, leave the container alone" so a missing/not-yet-
 * loaded image never triggers a destructive recreate.
 */
async function resolveImageId(tag: string): Promise<string | null> {
  return docker
    .getImage(tag)
    .inspect()
    .then((info) => info.Id)
    .catch(() => null);
}

async function buildExpectedContainerCreateOptions(record: ContainerWithUser, suppliedRuntime?: ManagedRuntime) {
  const runtime = suppliedRuntime ?? await prepareManagedRuntime(record.userId);
  return {
    runtime,
    options: buildContainerCreateOptions({ record: { ...record, image: config.opencodeImage }, runtime }),
  };
}

async function createDockerContainer(record: ContainerWithUser, containerOpts?: Docker.ContainerCreateOptions) {
  await ensureNetwork();
  containerOpts ??= (await buildExpectedContainerCreateOptions(record)).options;

  const created = await docker.createContainer(containerOpts);

  await prisma.containerInstance.update({
    where: { id: record.id },
    data: {
      dockerContainerId: created.id,
      image: config.opencodeImage,
      status: ContainerStatus.CREATING,
      deletedAt: null,
      lastError: null,
    },
  });

  return created;
}

async function createActivity(input: {
  userId: string;
  containerId?: string | null;
  kind: "proxy" | "start" | "stop" | "delete";
  detail: string;
}) {
  await prisma.containerActivity.create({
    data: {
      userId: input.userId,
      containerId: input.containerId ?? null,
      kind: input.kind,
      detail: input.detail,
    },
  });
}

async function touchProxyActivity(record: ContainerInstance) {
  const now = new Date();

  await prisma.containerInstance.update({
    where: { id: record.id },
    data: {
      lastActivityAt: now,
      deletedAt: null,
    },
  });

  const latest = await prisma.containerActivity.findFirst({
    where: {
      containerId: record.id,
      kind: "proxy",
    },
    orderBy: {
      occurredAt: "desc",
    },
  });

  if (
    !latest ||
    now.getTime() - latest.occurredAt.getTime() >= proxyActivityThrottleMs
  ) {
    await createActivity({
      userId: record.userId,
      containerId: record.id,
      kind: "proxy",
      detail: "Gateway forwarded traffic to the opencode container.",
    });
  }
}

async function updateContainerAfterTransition(
  containerId: string,
  data: Prisma.ContainerInstanceUpdateInput,
) {
  return prisma.containerInstance.update({
    where: { id: containerId },
    data,
    include: {
      user: true,
    },
  });
}

function createLifecycleLockOwner(kind: string, containerId: string) {
  return `${kind}:${containerId}:${randomUUID()}`;
}

async function acquireContainerLifecycleLock(
  containerId: string,
  owner: string,
) {
  const staleBefore = new Date(Date.now() - lifecycleLockTtlMs);
  const result = await prisma.containerInstance.updateMany({
    where: {
      id: containerId,
      OR: [
        { lifecycleLockedAt: null },
        { lifecycleLockedAt: { lte: staleBefore } },
        { lifecycleLockOwner: owner },
      ],
    },
    data: {
      lifecycleLockedAt: new Date(),
      lifecycleLockOwner: owner,
    },
  });

  return result.count === 1;
}

async function releaseContainerLifecycleLock(
  containerId: string,
  owner: string,
) {
  await prisma.containerInstance.updateMany({
    where: {
      id: containerId,
      lifecycleLockOwner: owner,
    },
    data: {
      lifecycleLockedAt: null,
      lifecycleLockOwner: null,
    },
  });
}

async function waitForContainerLifecycle(containerId: string) {
  const deadline = Date.now() + lifecycleWaitTimeoutMs;

  while (Date.now() < deadline) {
    const record = await prisma.containerInstance.findUnique({
      where: { id: containerId },
      include: { user: true },
    });

    if (!record) {
      return null;
    }

    const dockerContainer = await resolveDockerContainer(record);
    const inspect = await dockerContainer?.inspect().catch(() => null);

    if (record.status === ContainerStatus.RUNNING && inspect?.State?.Running) {
      return record;
    }

    if (
      record.lifecycleLockedAt &&
      isLifecycleLockExpired(record.lifecycleLockedAt)
    ) {
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, lifecycleWaitIntervalMs));
  }

  throw new ContainerLifecycleLockError();
}

async function markWakeAttempt(record: ContainerInstance) {
  const latest = await prisma.containerInstance.findUnique({
    where: { id: record.id },
    select: {
      lastWakeAttemptAt: true,
      lifecycleLockedAt: true,
      lifecycleLockOwner: true,
    },
  });

  if (
    latest &&
    isWakeAttemptCoolingDown(latest.lastWakeAttemptAt) &&
    !isLifecycleLockExpired(latest.lifecycleLockedAt)
  ) {
    if (latest.lifecycleLockOwner?.startsWith("start:")) {
      return;
    }
    throw new ContainerLifecycleLockError();
  }

  if (latest && isWakeAttemptCoolingDown(latest.lastWakeAttemptAt)) {
    throw new WakeAttemptCoolingDownError();
  }

  await prisma.containerInstance.update({
    where: { id: record.id },
    data: {
      lastWakeAttemptAt: new Date(),
    },
  });
}

export async function ensureContainerRecordForUser(userId: string) {
  const existing = await prisma.containerInstance.findUnique({
    where: { userId },
    include: {
      user: true,
    },
  });

  if (existing) {
    return existing;
  }

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
  });

  const meta = buildContainerMeta(user);

  return prisma.containerInstance.create({
    data: {
      userId: user.id,
      name: meta.name,
      proxySlug: meta.proxySlug,
      image: config.opencodeImage,
      status: ContainerStatus.STOPPED,
    },
    include: {
      user: true,
    },
  });
}

async function startContainerRecordUnlocked(record: ContainerWithUser, suppliedRuntime?: ManagedRuntime) {
  let dockerContainer = await resolveDockerContainer(record);
  const expected = await buildExpectedContainerCreateOptions(record, suppliedRuntime);
  const expectedOptions = expected.options;

  if (!dockerContainer) {
    dockerContainer = await createDockerContainer(record, expectedOptions);
  } else {
    const inspect = await dockerContainer.inspect().catch(() => null);
    // A stopped container keeps its original image ID; `docker start` would
    // resume it on the OLD image even after the operator replaced the
    // `:latest` tag. So if the tag now resolves to a different image ID than
    // the container was built from, treat it as stale and recreate — this is
    // how an image swap propagates: each container lazily updates on its next
    // wake, no manual rebuild needed. resolveImageId returns null when the tag
    // is missing, which leaves the container untouched.
    const currentImageId = await resolveImageId(config.opencodeImage);
    const imageDrifted =
      !!currentImageId && !!inspect?.Image && inspect.Image !== currentImageId;
    const imageEnvironment = inspect
      ? await docker.getImage(inspect.Image).inspect().then((image) => image.Config.Env ?? [])
      : [];
    if (inspect && (imageDrifted || isStaleRuntime(inspect, expectedOptions, imageEnvironment))) {
      // Container's image, command, or bind list no longer matches the current
      // runtime shape (new image tag, a new sync script, changed template
      // mounts…). Recreate so this start picks up the latest.
      await dockerContainer.remove({ force: true }).catch(() => undefined);
      dockerContainer = await createDockerContainer(record, expectedOptions);
    }
  }

  // Do not call a container "ready" merely because its process stayed alive.
  try {
    await startContainerIfNeeded(dockerContainer);
  } catch (error) {
    const previousContainer = dockerContainer;

    await previousContainer.remove({ force: true }).catch(() => undefined);
    dockerContainer = await createDockerContainer(record, expectedOptions);

    try {
      await startContainerIfNeeded(dockerContainer);
    } catch {
      const message =
        error instanceof Error ? error.message : "Container start failed";

      await prisma.containerInstance.update({
        where: { id: record.id },
        data: {
          status: ContainerStatus.ERROR,
          lastError: message,
        },
      });

      throw error;
    }
  }

  const verified = await dockerContainer.inspect().catch(() => null);

  if (!verified?.State?.Running) {
    const failureMessage =
      verified?.State?.Error ||
      `Container did not stay running (state: ${verified?.State?.Status ?? "unknown"})`;

    await prisma.containerInstance.update({
      where: { id: record.id },
      data: {
        status: ContainerStatus.ERROR,
        lastError: failureMessage,
      },
    });

    throw new Error(failureMessage);
  }

  const password = await getRuntimePassword(record.userId);
  const healthDeadline = Date.now() + 60_000;
  let healthy = false;
  while (Date.now() < healthDeadline) {
    const responses = await Promise.all([
      "/global/health", "/agent?directory=%2Fworkspace", "/session?directory=%2Fworkspace",
    ].map((route) => fetch(`${getContainerProxyTarget(record)}${route}`, {
      headers: { authorization: runtimeAuthorization(password) },
      signal: AbortSignal.timeout(2_000),
    }).then(async (response) => { await response.arrayBuffer(); return response.ok; }).catch(() => false)));
    healthy = responses.every(Boolean);
    if (healthy) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  if (!healthy) {
    await prisma.containerInstance.update({
      where: { id: record.id },
      data: { status: ContainerStatus.ERROR, lastError: "OpenCode 健康检查未通过" },
    });
    throw new Error("OpenCode 健康检查未通过");
  }

  const actualAgentKeys = await fetchActualBusinessAgentKeys(record);
  if (
    actualAgentKeys.length !== expected.runtime.agentKeys.length ||
    actualAgentKeys.some((key, index) => key !== expected.runtime.agentKeys[index])
  ) {
    const failureMessage = `运行环境智能体清单不一致：期望 ${expected.runtime.agentKeys.join(", ")}，实际 ${actualAgentKeys.join(", ")}`;
    await dockerContainer.stop({ t: 5 }).catch(() => undefined);
    await prisma.containerInstance.update({
      where: { id: record.id },
      data: { status: ContainerStatus.ERROR, lastError: failureMessage },
    });
    throw new Error(failureMessage);
  }

  const now = new Date();
  const updated = await updateContainerAfterTransition(record.id, {
    status: ContainerStatus.RUNNING,
    dockerContainerId: dockerContainer.id,
    lastStartedAt: now,
    lastActivityAt: now,
    deletedAt: null,
    lastError: null,
    appliedRuntimeHash: expected.runtime.generation,
    appliedGeneration: expected.runtime.desiredGeneration,
  });

  await createActivity({
    userId: updated.userId,
    containerId: updated.id,
    kind: "start",
    detail: "Gateway started the dedicated opencode container.",
  });

  return updated;
}

export async function startContainerByUserId(
  userId: string,
  options: StartContainerOptions = {},
) {
  const record = await ensureContainerRecordForUser(userId);
  if (
    record.configApplyStatus !== "READY" ||
    record.desiredGeneration !== record.appliedGeneration
  ) {
    throw new RuntimeConfigurationUnavailableError(record.configApplyError ?? undefined);
  }
  const lockOwner =
    options.lockOwner ?? createLifecycleLockOwner("start", record.id);
  const acquired = await acquireContainerLifecycleLock(record.id, lockOwner);

  if (!acquired) {
    if (options.waitForExisting !== false) {
      const existing = await waitForContainerLifecycle(record.id);
      if (existing) {
        return existing;
      }
    }

    throw new ContainerLifecycleLockError();
  }

  try {
    return await startContainerRecordUnlocked(record);
  } finally {
    await releaseContainerLifecycleLock(record.id, lockOwner);
  }
}

const internalAgentKeys = new Set([
  "build",
  "plan",
  "general",
  "explore",
  "compaction",
  "title",
  "summary",
  "customize-opencode",
]);

async function fetchRuntimeJson(record: ContainerInstance, route: string) {
  const response = await fetch(`${getContainerProxyTarget(record)}${route}`, {
    headers: { authorization: runtimeAuthorization(await getRuntimePassword(record.userId)) },
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error(`OpenCode ${route} 返回 ${response.status}`);
  return response.json() as Promise<unknown>;
}

export async function fetchActualBusinessAgentKeys(record: ContainerInstance) {
  const payload = await fetchRuntimeJson(record, "/agent?directory=%2Fworkspace");
  const keys = Array.isArray(payload)
    ? payload.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const name = (entry as { name?: unknown }).name;
      return typeof name === "string" ? [name] : [];
    })
    : payload && typeof payload === "object"
      ? Object.keys(payload)
      : [];
  return Array.from(new Set(keys.filter((key) => !internalAgentKeys.has(key)))).sort();
}

export async function getRuntimeWorkState(record: ContainerInstance) {
  const [status, questions, permissions, sessions] = await Promise.all([
    fetchRuntimeJson(record, "/session/status?directory=%2Fworkspace"),
    fetchRuntimeJson(record, "/question?directory=%2Fworkspace"),
    fetchRuntimeJson(record, "/permission?directory=%2Fworkspace"),
    fetchRuntimeJson(record, "/session?directory=%2Fworkspace"),
  ]);
  const busySessionIds = status && typeof status === "object"
    ? Object.entries(status)
      .filter(([, value]) => (value as { type?: unknown } | null)?.type === "busy")
      .map(([sessionId]) => sessionId)
      .sort()
    : [];
  const pendingQuestions = Array.isArray(questions) ? questions.length : 0;
  const pendingPermissions = Array.isArray(permissions) ? permissions.length : 0;
  const sessionRows = Array.isArray(sessions) ? sessions.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const row = value as { id?: unknown; parentID?: unknown };
    return typeof row.id === "string"
      ? [{ id: row.id, parentID: typeof row.parentID === "string" ? row.parentID : null }]
      : [];
  }) : [];
  const parents = new Map(sessionRows.map((row) => [row.id, row.parentID]));
  const rootOf = (sessionId: string) => {
    let current = sessionId;
    const seen = new Set<string>();
    while (parents.get(current) && !seen.has(current)) {
      seen.add(current);
      current = parents.get(current)!;
    }
    return current;
  };
  const requests = (payload: unknown) => Array.isArray(payload) ? payload.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const row = value as { id?: unknown; sessionID?: unknown; sessionId?: unknown };
    const sessionId = typeof row.sessionID === "string" ? row.sessionID : row.sessionId;
    return typeof row.id === "string" && typeof sessionId === "string"
      ? [{ id: row.id, sessionId }]
      : [];
  }) : [];
  const questionRequests = requests(questions);
  const permissionRequests = requests(permissions);
  const activeSessionIds = Array.from(new Set([
    ...busySessionIds,
    ...questionRequests.map((item) => item.sessionId),
    ...permissionRequests.map((item) => item.sessionId),
  ])).sort();
  const rootSessionIds = Array.from(new Set(activeSessionIds.map(rootOf))).sort();
  return {
    busySessionIds,
    pendingQuestions,
    pendingPermissions,
    activeSessionIds,
    rootSessionIds,
    questionRequestIds: questionRequests.map((item) => item.id).sort(),
    permissionRequestIds: permissionRequests.map((item) => item.id).sort(),
    idle: busySessionIds.length === 0 && pendingQuestions === 0 && pendingPermissions === 0,
  };
}

export async function stopContainerRecord(record: ContainerWithUser) {
  await stopDockerContainerIfRunning(record);

  const now = new Date();
  const updated = await updateContainerAfterTransition(record.id, {
    status: ContainerStatus.STOPPED,
    lastStoppedAt: now,
    deletedAt: null,
    lastError: null,
  });

  await createActivity({
    userId: updated.userId,
    containerId: updated.id,
    kind: "stop",
    detail: "Gateway stopped the opencode container after an explicit action or idle timeout.",
  });

  return updated;
}

async function stopDockerContainerIfRunning(record: ContainerWithUser) {
  const dockerContainer = await resolveDockerContainer(record);

  return dockerContainer ? stopRuntimeIfRunning(dockerContainer) : false;
}

export async function stopContainerById(containerId: string) {
  const record = await prisma.containerInstance.findUnique({
    where: { id: containerId },
    include: {
      user: true,
    },
  });

  if (!record) {
    return null;
  }

  const lockOwner = createLifecycleLockOwner("stop", record.id);
  const acquired = await acquireContainerLifecycleLock(record.id, lockOwner);

  if (!acquired) {
    throw new ContainerLifecycleLockError();
  }

  try {
    const latest = await prisma.containerInstance.findUnique({
      where: { id: record.id },
      include: { user: true },
    });

    if (!latest) {
      return null;
    }

    assertExecutionIdle(latest);

    return await stopContainerRecord(latest);
  } finally {
    await releaseContainerLifecycleLock(record.id, lockOwner);
  }
}

async function restartContainerRecordUnlocked(record: ContainerWithUser) {
  const stoppedRunningContainer = await stopDockerContainerIfRunning(record);
  let nextRecord = record;

  if (stoppedRunningContainer || record.status === ContainerStatus.RUNNING) {
    const now = new Date();
    nextRecord = await updateContainerAfterTransition(record.id, {
      status: ContainerStatus.STOPPED,
      lastStoppedAt: now,
      deletedAt: null,
      lastError: null,
    });

    await createActivity({
      userId: nextRecord.userId,
      containerId: nextRecord.id,
      kind: "stop",
      detail: "Gateway stopped the opencode container before restarting it.",
    });
  }

  return startContainerRecordUnlocked(nextRecord);
}

export async function restartContainerByUserId(userId: string) {
  const record = await prisma.containerInstance.findUnique({
    where: { userId },
    include: { user: true },
  });

  if (!record) {
    return null;
  }

  const lockOwner = createLifecycleLockOwner("restart", record.id);
  const acquired = await acquireContainerLifecycleLock(record.id, lockOwner);

  if (!acquired) {
    throw new ContainerLifecycleLockError();
  }

  try {
    const latest = await prisma.containerInstance.findUnique({
      where: { id: record.id },
      include: { user: true },
    });

    if (!latest) {
      return null;
    }

    assertExecutionIdle(latest);

    return await restartContainerRecordUnlocked(latest);
  } finally {
    await releaseContainerLifecycleLock(record.id, lockOwner);
  }
}

export async function restartContainerById(containerId: string) {
  const record = await prisma.containerInstance.findUnique({
    where: { id: containerId },
  });

  if (!record) {
    return null;
  }

  return restartContainerByUserId(record.userId);
}

export async function recreateContainerRuntimeByUserId(userId: string, runtime?: ManagedRuntime) {
  const record = await ensureContainerRecordForUser(userId);
  assertExecutionIdle(record);
  const lockOwner = createLifecycleLockOwner("recreate", record.id);
  const acquired = await acquireContainerLifecycleLock(record.id, lockOwner);

  if (!acquired) {
    throw new ContainerLifecycleLockError();
  }

  try {
    const dockerContainer = await resolveDockerContainer(record);

    if (dockerContainer) {
      await dockerContainer.remove({
        force: true,
      }).catch(() => undefined);
    }

    const updatedRecord = await prisma.containerInstance.update({
      where: { id: record.id },
      data: {
        image: config.opencodeImage,
        dockerContainerId: null,
        status: ContainerStatus.STOPPED,
        deletedAt: null,
        lastError: null,
      },
      include: { user: true },
    });

    return await startContainerRecordUnlocked(updatedRecord, runtime);
  } finally {
    await releaseContainerLifecycleLock(record.id, lockOwner);
  }
}

export async function recreateContainerRuntimeById(containerId: string) {
  const record = await prisma.containerInstance.findUnique({
    where: { id: containerId },
  });

  if (!record) {
    return null;
  }

  return recreateContainerRuntimeByUserId(record.userId);
}

/** 删除旧容器和其中的只读配置挂载，但保留用户 workspace/state。 */
export async function discardContainerRuntimeByUserId(userId: string) {
  const record = await ensureContainerRecordForUser(userId);
  const lockOwner = createLifecycleLockOwner("discard-runtime", record.id);
  const acquired = await acquireContainerLifecycleLock(record.id, lockOwner);
  if (!acquired) throw new ContainerLifecycleLockError();
  try {
    const latest = await prisma.containerInstance.findUnique({
      where: { id: record.id },
      include: { user: true },
    });
    if (!latest) return null;
    assertExecutionIdle(latest);
    const dockerContainer = await resolveDockerContainer(latest);
    if (dockerContainer) {
      await dockerContainer.remove({ force: true });
      const remaining = await dockerContainer.inspect().catch(() => null);
      if (remaining?.State?.Running) throw new Error("旧运行环境未能停止");
    }
    return updateContainerAfterTransition(latest.id, {
      dockerContainerId: null,
      status: ContainerStatus.STOPPED,
      lastStoppedAt: new Date(),
      deletedAt: null,
      lastError: null,
    });
  } finally {
    await releaseContainerLifecycleLock(record.id, lockOwner);
  }
}

export async function deleteContainerByUserId(userId: string) {
  const record = await prisma.containerInstance.findUnique({
    where: { userId },
    include: {
      user: true,
    },
  });

  if (!record) {
    return null;
  }

  assertExecutionIdle(record);

  return deleteContainerById(record.id);
}

export async function deleteContainerById(containerId: string) {
  const record = await prisma.containerInstance.findUnique({
    where: { id: containerId },
    include: {
      user: true,
    },
  });

  if (!record) {
    return null;
  }

  // Removing an execution container must not erase the user's native sessions
  // or orphan the Conversation/Execution indexes. Account deletion owns data removal.
  return discardContainerRuntimeByUserId(record.userId);
}

export async function touchContainerByProxySlug(proxySlug: string) {
  const record = await prisma.containerInstance.findUnique({
    where: { proxySlug },
    include: {
      user: true,
    },
  });

  if (!record) {
    return null;
  }

  let nextRecord = record;

  const dockerContainer = await resolveDockerContainer(record);
  const inspect = await dockerContainer?.inspect().catch(() => null);

  if (record.status !== ContainerStatus.RUNNING || !inspect?.State?.Running) {
    await markWakeAttempt(record);
    nextRecord = await startContainerByUserId(record.userId, {
      waitForExisting: true,
    });
  }

  await touchProxyActivity(nextRecord);

  return nextRecord;
}

export async function getContainerById(containerId: string) {
  return prisma.containerInstance.findUnique({
    where: { id: containerId },
    include: {
      user: true,
    },
  });
}

export async function fetchContainerLogs(record: ContainerInstance, tail = 200) {
  const docker = await resolveDockerContainer(record);
  if (!docker) {
    return null;
  }
  const cappedTail = Math.max(1, Math.min(2000, Math.floor(tail)));
  const buffer = (await docker.logs({
    stdout: true,
    stderr: true,
    tail: cappedTail,
    follow: false,
    timestamps: false,
  })) as unknown as Buffer;
  return demuxLogStream(buffer);
}

function demuxLogStream(raw: Buffer): string {
  // Docker multiplexed stream: 8-byte header per chunk when no TTY.
  // Header[0] = stream (1 stdout, 2 stderr), Header[4..8] = payload length BE.
  const out: string[] = [];
  let offset = 0;
  while (offset + 8 <= raw.length) {
    const stream = raw[offset];
    const size = raw.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > raw.length) break;
    if (stream === 1 || stream === 2) {
      out.push(raw.slice(start, end).toString("utf-8"));
      offset = end;
    } else {
      // Stream not in expected format (likely raw text from TTY container).
      return raw.toString("utf-8");
    }
  }
  if (out.length === 0) {
    return raw.toString("utf-8");
  }
  return out.join("");
}

export async function getContainerByUserId(userId: string) {
  return prisma.containerInstance.findUnique({
    where: { userId },
    include: {
      user: true,
    },
  });
}

export async function getContainerByProxySlug(proxySlug: string) {
  return prisma.containerInstance.findUnique({
    where: { proxySlug },
    include: {
      user: true,
    },
  });
}

export async function isContainerRuntimeRunning(record: ContainerInstance) {
  const container = await resolveDockerContainer(record);
  const inspect = await container?.inspect().catch(() => null);
  return Boolean(inspect?.State?.Running);
}

export function getContainerProxyTarget(container: Pick<ContainerInstance, "name">) {
  return `http://${container.name}:${config.opencodePort}`;
}

export async function getActiveContainerRuntime(record: ContainerInstance) {
  const container = await resolveDockerContainer(record);
  if (!container) throw new Error("Container not found");
  const info = await container.inspect();
  return readManagedRuntime(record.userId, info.Config.Labels["opshelper.generation"] ?? "");
}
