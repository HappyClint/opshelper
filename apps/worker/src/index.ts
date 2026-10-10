import Docker from "dockerode";
import {
  ContainerStatus,
  ExecutionStatus,
  Prisma,
  PrismaClient,
  ScheduleFrequency,
  ScheduleRunDecision,
  ScheduleRunTrigger,
  ScheduleStatus,
  type Schedule,
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { nextScheduleOccurrence, stopDockerContainerIfRunning } from "@opshelper/shared";

const prisma = new PrismaClient();
const docker = new Docker({
  socketPath: process.env.DOCKER_SOCKET_PATH ?? "/var/run/docker.sock",
});

const idleIntervalMs = 5 * 60 * 1000;
const schedulePollMs = Number(process.env.OPSHELPER_SCHEDULE_POLL_MS ?? "15000");
const scheduleLateGraceMs = Number(process.env.OPSHELPER_SCHEDULE_LATE_GRACE_MS ?? "120000");
const idleTimeoutMinutes = Number(
  process.env.OPSHELPER_IDLE_TIMEOUT_MINUTES ?? "60",
);
const lifecycleLockTtlMs = 2 * 60 * 1000;

function createLifecycleLockOwner(containerId: string) {
  return `worker-idle-stop:${containerId}:${randomUUID()}`;
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

async function stopIdleContainer(container: {
  id: string;
  userId: string;
  name: string;
  threshold: Date;
}) {
  const lockOwner = createLifecycleLockOwner(container.id);
  const acquired = await acquireContainerLifecycleLock(container.id, lockOwner);

  if (!acquired) {
    console.log(
      `[worker] skipping ${container.id} (${container.name}); lifecycle operation already in progress.`,
    );
    return;
  }

  try {
    const latest = await prisma.containerInstance.findUnique({
      where: { id: container.id },
      select: {
        id: true,
        status: true,
        lastActivityAt: true,
        activeExecutionId: true,
        executionRecoveryRequired: true,
        executionLeaseExpiresAt: true,
        configApplyStatus: true,
        user: {
          select: {
            keepContainerAlive: true,
          },
        },
      },
    });

    // Re-check under the lifecycle lock before stopping. The worker is a
    // standalone deploy unit and deliberately does not import the api package,
    // so this idle rule lives inline here rather than in a shared helper.
    if (
      !latest ||
      latest.status !== ContainerStatus.RUNNING ||
      !latest.lastActivityAt ||
      latest.user.keepContainerAlive ||
      latest.activeExecutionId ||
      latest.executionRecoveryRequired ||
      latest.configApplyStatus !== "READY" ||
      (latest.executionLeaseExpiresAt && latest.executionLeaseExpiresAt > new Date()) ||
      latest.lastActivityAt > container.threshold
    ) {
      console.log(
        `[worker] skipping ${container.id} (${container.name}); no longer idle.`,
      );
      return;
    }

    const dockerContainer = docker.getContainer(container.name);

    await stopDockerContainerIfRunning(dockerContainer);

    const now = new Date();

    await prisma.containerInstance.update({
      where: {
        id: container.id,
      },
      data: {
        status: ContainerStatus.STOPPED,
        lastStoppedAt: now,
        lastError: null,
      },
    });

    await prisma.containerActivity.create({
      data: {
        userId: container.userId,
        containerId: container.id,
        kind: "stop",
        detail: `Idle timeout exceeded ${idleTimeoutMinutes} minutes, worker stopped the opencode container.`,
      },
    });
  } finally {
    await releaseContainerLifecycleLock(container.id, lockOwner);
  }
}

async function tick() {
  const now = new Date();
  const threshold = new Date(now.getTime() - idleTimeoutMinutes * 60 * 1000);
  const idleContainers = await prisma.containerInstance.findMany({
    where: {
      status: ContainerStatus.RUNNING,
      lastActivityAt: {
        lte: threshold,
      },
      user: {
        keepContainerAlive: false,
      },
      activeExecutionId: null,
      executionRecoveryRequired: false,
      configApplyStatus: "READY",
      OR: [
        { executionLeaseExpiresAt: null },
        { executionLeaseExpiresAt: { lte: now } },
      ],
    },
    select: {
      id: true,
      userId: true,
      name: true,
      lastActivityAt: true,
    },
  });

  console.log(
    `[worker] ${now.toISOString()} idle-stop scan complete, ${idleContainers.length} candidate(s) found.`,
  );

  for (const container of idleContainers) {
    console.log(
      `[worker] stopping ${container.id} (${container.name}) last active at ${container.lastActivityAt?.toISOString() ?? "never"}`,
    );
    await stopIdleContainer({
      ...container,
      threshold,
    });
  }
}

function stringArray(value: Prisma.JsonValue) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function scheduleRule(schedule: Schedule) {
  return {
    frequency: schedule.frequency.toLowerCase() as "once" | "daily" | "weekly" | "cron",
    localTime: schedule.localTime,
    weekday: schedule.weekday,
    onceAt: schedule.onceAt,
    cronExpression: schedule.cronExpression,
  };
}

function snapshot(schedule: Schedule) {
  return {
    name: schedule.name,
    prompt: schedule.prompt,
    leadAgentKey: schedule.leadAgentKey,
    participantAgentKeys: stringArray(schedule.participantAgentKeys),
    attachments: schedule.attachments,
    model: schedule.model,
    autoApprovePermissions: schedule.autoApprovePermissions,
    frequency: schedule.frequency.toLowerCase(),
    localTime: schedule.localTime,
    weekday: schedule.weekday,
    onceAt: schedule.onceAt?.toISOString() ?? null,
    cronExpression: schedule.cronExpression,
    timeZone: "Asia/Shanghai",
  };
}

function missedWindow(schedule: Schedule, dueAt: Date, now: Date) {
  let count = 1;
  let through = dueAt;
  let cursor = dueAt;
  for (let index = 0; index < 10_000; index++) {
    const next = nextScheduleOccurrence(scheduleRule(schedule), cursor);
    if (!next || next > now) break;
    count += 1;
    through = next;
    cursor = next;
  }
  return { count, through };
}

const runningStatuses = [
  ExecutionStatus.QUEUED,
  ExecutionStatus.DISPATCHING,
  ExecutionStatus.RUNNING,
  ExecutionStatus.WAITING_INPUT,
];

async function processDueSchedule(scheduleId: string, expectedNextRunAt: Date, now: Date) {
  return prisma.$transaction(async (tx) => {
    const schedule = await tx.schedule.findUnique({
      where: { id: scheduleId },
      include: {
        user: {
          include: {
            agents: { include: { agent: true } },
            container: true,
          },
        },
        runs: {
          where: {
            decision: ScheduleRunDecision.ENQUEUED,
            execution: { status: { in: runningStatuses } },
          },
          take: 1,
        },
      },
    });
    if (
      !schedule ||
      schedule.status !== ScheduleStatus.ACTIVE ||
      !schedule.nextRunAt ||
      schedule.nextRunAt.getTime() !== expectedNextRunAt.getTime()
    ) {
      return "stale";
    }

    const dueAt = schedule.nextRunAt;
    const future = schedule.frequency === ScheduleFrequency.ONCE
      ? null
      : nextScheduleOccurrence(scheduleRule(schedule), now);
    const completed = schedule.frequency === ScheduleFrequency.ONCE;
    const available = new Set(
      schedule.user.agents
        .filter(({ agent }) => agent.isEnabled && agent.checkStatus === "READY")
        .map(({ agent }) => agent.key),
    );
    const required = [schedule.leadAgentKey, ...stringArray(schedule.participantAgentKeys)];
    const missing = required.find((key) => !available.has(key));
    const late = now.getTime() - dueAt.getTime() > scheduleLateGraceMs;
    const frozen = schedule.user.container?.configApplyStatus === "FROZEN";
    let skipReason: string | null = null;
    let pauseReason: string | null = null;
    if (!schedule.user.isActive) {
      skipReason = "用户已停用，本次计划未执行";
      pauseReason = skipReason;
    } else if (missing) {
      skipReason = `所需智能体「${missing}」已不可用，本次计划未执行`;
      pauseReason = skipReason;
    } else if (frozen) {
      skipReason = schedule.user.container?.configApplyError ?? "运行环境配置已冻结，本次计划未执行";
      pauseReason = skipReason;
    } else if (late) {
      skipReason = "服务停机期间错过计划时间，本次未补跑";
    } else if (schedule.runs.length > 0) {
      skipReason = "上一次计划执行尚未结束，本次已跳过";
    }

    const window = late ? missedWindow(schedule, dueAt, now) : { count: 0, through: null };
    const run = await tx.scheduleRun.create({
      data: {
        scheduleId: schedule.id,
        userId: schedule.userId,
        scheduledFor: dueAt,
        trigger: ScheduleRunTrigger.SCHEDULED,
        decision: skipReason ? ScheduleRunDecision.SKIPPED : ScheduleRunDecision.ENQUEUED,
        skipReason,
        missedCount: window.count,
        missedThrough: window.through,
        scheduleSnapshot: snapshot(schedule) as unknown as Prisma.InputJsonObject,
      },
    });

    if (!skipReason) {
      const container = schedule.user.container;
      if (!container) throw new Error(`Schedule ${schedule.id} has no fixed user container`);
      const conversation = await tx.conversation.create({
        data: {
          userId: schedule.userId,
          title: `定时任务 · ${schedule.name}`.slice(0, 120),
          lastAgentKey: schedule.leadAgentKey,
          lastConfigGeneration: container.desiredGeneration,
        },
      });
      await tx.execution.create({
        data: {
          userId: schedule.userId,
          conversationId: conversation.id,
          scheduleRunId: run.id,
          source: "SCHEDULED",
          requestKey: `schedule:${schedule.id}:${dueAt.toISOString()}`,
          leadAgentKey: schedule.leadAgentKey,
          agentKeysSnapshot: Array.from(available).sort(),
          configGeneration: container.desiredGeneration,
          inputText: schedule.prompt,
          attachments: schedule.attachments as Prisma.InputJsonValue,
          model: schedule.model,
          autoApprovePermissions: schedule.autoApprovePermissions,
          promptMarker: randomUUID(),
        },
      });
    }

    await tx.schedule.update({
      where: { id: schedule.id },
      data: {
        status: pauseReason
          ? ScheduleStatus.PAUSED
          : completed
            ? ScheduleStatus.COMPLETED
            : ScheduleStatus.ACTIVE,
        statusReason: pauseReason ?? (completed && skipReason ? skipReason : null),
        nextRunAt: pauseReason || completed ? null : future,
        lastScheduledAt: dueAt,
      },
    });
    return skipReason ? "skipped" : "queued";
  }, { isolationLevel: "Serializable" });
}

let scheduleTickRunning = false;
async function scheduleTick() {
  if (scheduleTickRunning) return;
  scheduleTickRunning = true;
  try {
    const now = new Date();
    const due = await prisma.schedule.findMany({
      where: { status: ScheduleStatus.ACTIVE, nextRunAt: { lte: now } },
      select: { id: true, nextRunAt: true },
      orderBy: { nextRunAt: "asc" },
      take: 100,
    });
    for (const item of due) {
      if (!item.nextRunAt) continue;
      try {
        const result = await processDueSchedule(item.id, item.nextRunAt, now);
        if (result !== "stale") {
          console.log(`[worker] schedule ${item.id} ${result} for ${item.nextRunAt.toISOString()}`);
        }
      } catch (error) {
        console.error(`[worker] schedule ${item.id} failed`, error);
      }
    }
  } finally {
    scheduleTickRunning = false;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void tick().catch((error) => console.error("[worker] idle scan failed", error));
  void scheduleTick().catch((error) => console.error("[worker] schedule scan failed", error));
  setInterval(() => {
    void tick().catch((error) => console.error("[worker] idle scan failed", error));
  }, idleIntervalMs);
  setInterval(() => {
    void scheduleTick().catch((error) => console.error("[worker] schedule scan failed", error));
  }, schedulePollMs);
}

export { missedWindow, processDueSchedule, scheduleTick };
