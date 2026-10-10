import { randomUUID } from "node:crypto";

import {
  ExecutionStatus,
  Prisma,
  ScheduleFrequency,
  ScheduleRunDecision,
  ScheduleRunTrigger,
  ScheduleStatus,
  type Execution,
  type Schedule,
  type ScheduleRun,
} from "@prisma/client";
import {
  SHANGHAI_OFFSET_MS,
  normalizeScheduleRule,
  type AgentMode,
  type ConversationAttachment,
  type ScheduleDetailResponse,
  type ScheduleInput,
  type ScheduleRunSummary,
  type ScheduleSummary,
  type SchedulesResponse,
} from "@opshelper/shared";

import { getChatModels } from "./admin-config-service";
import {
  kickExecutionLoop,
  readExecutionAnswer,
  serializeExecutionSummary,
  validateConversationAttachments,
} from "./conversation-service";
import { prisma } from "./prisma";

export class ScheduleServiceError extends Error {
  constructor(message: string, public readonly statusCode = 400) {
    super(message);
  }
}

type ScheduleWithRuns = Schedule & {
  runs: Array<ScheduleRun & { execution: Execution | null }>;
};

interface ScheduleSnapshot {
  name: string;
  prompt: string;
  leadAgentKey: string;
  participantAgentKeys: string[];
  attachments: ConversationAttachment[];
  model: string | null;
  autoApprovePermissions: boolean;
  frequency: "once" | "daily" | "weekly" | "cron";
  localTime: string;
  weekday: number | null;
  onceAt: string | null;
  cronExpression: string | null;
  timeZone: "Asia/Shanghai";
}

function jsonStringArray(value: Prisma.JsonValue): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function jsonAttachments(value: Prisma.JsonValue): ConversationAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || Array.isArray(item) || typeof item !== "object") return [];
    const row = item as Record<string, Prisma.JsonValue>;
    return typeof row.path === "string" &&
      typeof row.filename === "string" &&
      typeof row.mime === "string"
      ? [{ path: row.path, filename: row.filename, mime: row.mime }]
      : [];
  });
}

function frequencyValue(value: ScheduleFrequency): ScheduleSummary["frequency"] {
  return value.toLowerCase() as ScheduleSummary["frequency"];
}

function localDate(onceAt: Date | null) {
  if (!onceAt) return null;
  return new Date(onceAt.getTime() + SHANGHAI_OFFSET_MS).toISOString().slice(0, 10);
}

function scheduleSnapshot(schedule: Schedule): ScheduleSnapshot {
  return {
    name: schedule.name,
    prompt: schedule.prompt,
    leadAgentKey: schedule.leadAgentKey,
    participantAgentKeys: jsonStringArray(schedule.participantAgentKeys),
    attachments: jsonAttachments(schedule.attachments),
    model: schedule.model,
    autoApprovePermissions: schedule.autoApprovePermissions,
    frequency: frequencyValue(schedule.frequency),
    localTime: schedule.localTime,
    weekday: schedule.weekday,
    onceAt: schedule.onceAt?.toISOString() ?? null,
    cronExpression: schedule.cronExpression,
    timeZone: "Asia/Shanghai",
  };
}

function snapshotFromRun(run: ScheduleRun) {
  const value = run.scheduleSnapshot;
  if (!value || Array.isArray(value) || typeof value !== "object") return null;
  return value as unknown as ScheduleSnapshot;
}

export function serializeScheduleRun(
  run: ScheduleRun & { execution: Execution | null },
): ScheduleRunSummary {
  const snapshot = snapshotFromRun(run);
  return {
    id: run.id,
    trigger: run.trigger.toLowerCase() as ScheduleRunSummary["trigger"],
    decision: run.decision.toLowerCase() as ScheduleRunSummary["decision"],
    scheduledFor: run.scheduledFor.toISOString(),
    skipReason: run.skipReason,
    missedThrough: run.missedThrough?.toISOString() ?? null,
    missedCount: run.missedCount,
    execution: run.execution ? serializeExecutionSummary(run.execution, null) : null,
    conversationId: run.execution?.conversationId ?? null,
    plannedAgentKeys: snapshot
      ? [snapshot.leadAgentKey, ...snapshot.participantAgentKeys]
      : [],
  };
}

function serializeSchedule(schedule: ScheduleWithRuns): ScheduleSummary {
  const lastRun = schedule.runs[0] ? serializeScheduleRun(schedule.runs[0]) : null;
  const status = schedule.status.toLowerCase() as ScheduleSummary["status"];
  return {
    id: schedule.id,
    name: schedule.name,
    prompt: schedule.prompt,
    leadAgentKey: schedule.leadAgentKey,
    participantAgentKeys: jsonStringArray(schedule.participantAgentKeys),
    attachments: jsonAttachments(schedule.attachments),
    model: schedule.model,
    autoApprovePermissions: schedule.autoApprovePermissions,
    frequency: frequencyValue(schedule.frequency),
    localDate: localDate(schedule.onceAt),
    localTime: schedule.localTime,
    weekday: schedule.weekday,
    cronExpression: schedule.cronExpression,
    timeZone: "Asia/Shanghai",
    status,
    statusReason: schedule.statusReason,
    nextRunAt: schedule.nextRunAt?.toISOString() ?? null,
    lastRun,
    canResume: status === "paused",
    canRunNow: status !== "paused",
    createdAt: schedule.createdAt.toISOString(),
    updatedAt: schedule.updatedAt.toISOString(),
  };
}

async function requireOwnedSchedule(userId: string, scheduleId: string) {
  const schedule = await prisma.schedule.findFirst({
    where: { id: scheduleId, userId },
  });
  if (!schedule) throw new ScheduleServiceError("定时任务不存在", 404);
  return schedule;
}

async function availableAgents(userId: string) {
  return prisma.userAgent.findMany({
    where: { userId, agent: { isEnabled: true, checkStatus: "READY" } },
    include: { agent: true },
    orderBy: { agent: { displayName: "asc" } },
  });
}

export function assertScheduleAgentModes(
  leadMode: string,
  participants: Array<{ key: string; mode: string }>,
): void {
  if (leadMode === "subagent") {
    throw new ScheduleServiceError("子智能体不能作为定时任务的主智能体", 400);
  }
  const primaryParticipant = participants.find((agent) => agent.mode === "primary");
  if (primaryParticipant) {
    throw new ScheduleServiceError(`主智能体「${primaryParticipant.key}」不能作为协作智能体`, 400);
  }
}

async function validateDependencies(
  userId: string,
  leadAgentKey: string,
  participantAgentKeys: string[],
  requireReadyRuntime = true,
) {
  const normalizedParticipants = Array.from(new Set(
    participantAgentKeys.map((key) => key.trim()).filter((key) => key && key !== leadAgentKey),
  )).sort();
  const [assignments, container] = await Promise.all([
    availableAgents(userId),
    prisma.containerInstance.findUnique({ where: { userId } }),
  ]);
  const available = new Set(assignments.map(({ agent }) => agent.key));
  const missing = [leadAgentKey, ...normalizedParticipants].find((key) => !available.has(key));
  if (missing) throw new ScheduleServiceError(`智能体「${missing}」当前不可用或未分配`, 409);
  const byKey = new Map(assignments.map(({ agent }) => [agent.key, agent]));
  assertScheduleAgentModes(
    byKey.get(leadAgentKey)!.mode,
    normalizedParticipants.map((key) => ({ key, mode: byKey.get(key)!.mode })),
  );
  if (
    requireReadyRuntime &&
    (!container ||
      container.configApplyStatus !== "READY" ||
      container.desiredGeneration !== container.appliedGeneration ||
      container.executionRecoveryRequired)
  ) {
    throw new ScheduleServiceError(
      container?.executionRecoveryReason ?? container?.configApplyError ?? "智能体配置尚未完成装配",
      503,
    );
  }
  return { assignments, container, participantAgentKeys: normalizedParticipants };
}

async function validateModel(model: string | undefined) {
  const normalized = model?.trim() || null;
  if (!normalized) return null;
  const settings = await getChatModels();
  if (!settings.models.some((item) => item.model === normalized)) {
    throw new ScheduleServiceError("所选模型当前不可用", 409);
  }
  return normalized;
}

async function normalizedScheduleInput(userId: string, input: ScheduleInput, now = new Date()) {
  const name = input.name.trim();
  const prompt = input.prompt.trim();
  if (!name) throw new ScheduleServiceError("请输入任务名称");
  if (!prompt) throw new ScheduleServiceError("请输入可以独立理解的任务说明");
  const dependencies = await validateDependencies(
    userId,
    input.leadAgentKey,
    input.participantAgentKeys,
  );
  await validateConversationAttachments(userId, input.attachments);
  const model = await validateModel(input.model);
  try {
    const rule = normalizeScheduleRule(input.rule, now);
    return {
      name,
      prompt,
      model,
      autoApprovePermissions: input.autoApprovePermissions === true,
      dependencies,
      rule,
    };
  } catch (error) {
    throw new ScheduleServiceError(error instanceof Error ? error.message : "执行时间不正确");
  }
}

export async function listSchedules(userId: string): Promise<SchedulesResponse> {
  const [agents, schedules] = await Promise.all([
    availableAgents(userId),
    prisma.schedule.findMany({
      where: { userId },
      include: {
        runs: {
          include: { execution: true },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
      },
      orderBy: { createdAt: "desc" },
    }),
  ]);
  return {
    agents: agents.map(({ agent }) => ({
      key: agent.key,
      name: agent.displayName,
      description: agent.description,
      mode: agent.mode as AgentMode,
    })),
    schedules: schedules.map(serializeSchedule),
  };
}

export async function getSchedule(userId: string, scheduleId: string): Promise<ScheduleDetailResponse> {
  const schedule = await prisma.schedule.findFirst({
    where: { id: scheduleId, userId },
    include: {
      runs: {
        include: { execution: true },
        orderBy: { createdAt: "desc" },
        take: 100,
      },
    },
  });
  if (!schedule) throw new ScheduleServiceError("定时任务不存在", 404);
  return {
    schedule: serializeSchedule(schedule),
    runs: schedule.runs.map(serializeScheduleRun),
  };
}

/**
 * 结果弹窗按需读取这一次执行的模型回答：历史记录里保存的摘要可能含推理内容和
 * 内部输出路径。运行环境暂不可用时返回 null，页面沿用已保存的结果。
 */
export async function getScheduleRunAnswer(userId: string, scheduleId: string, runId: string) {
  const run = await prisma.scheduleRun.findFirst({
    where: { id: runId, scheduleId, userId },
    include: { execution: true },
  });
  if (!run) throw new ScheduleServiceError("执行记录不存在", 404);
  if (!run.execution) return { runId: run.id, answer: null };
  try {
    return { runId: run.id, answer: await readExecutionAnswer(userId, run.execution) };
  } catch {
    return { runId: run.id, answer: null };
  }
}

function frequencyEnum(value: "once" | "daily" | "weekly" | "cron") {
  return value.toUpperCase() as ScheduleFrequency;
}

export async function createSchedule(userId: string, input: ScheduleInput) {
  const normalized = await normalizedScheduleInput(userId, input);
  const schedule = await prisma.schedule.create({
    data: {
      userId,
      name: normalized.name,
      prompt: normalized.prompt,
      leadAgentKey: input.leadAgentKey,
      participantAgentKeys: normalized.dependencies.participantAgentKeys,
      attachments: input.attachments as unknown as Prisma.InputJsonArray,
      model: normalized.model,
      autoApprovePermissions: normalized.autoApprovePermissions,
      frequency: frequencyEnum(normalized.rule.frequency),
      localTime: normalized.rule.localTime,
      weekday: normalized.rule.weekday,
      onceAt: normalized.rule.onceAt ? new Date(normalized.rule.onceAt) : null,
      cronExpression: normalized.rule.cronExpression,
      nextRunAt: normalized.rule.nextRunAt,
    },
  });
  return getSchedule(userId, schedule.id);
}

export async function updateSchedule(userId: string, scheduleId: string, input: ScheduleInput) {
  const existing = await requireOwnedSchedule(userId, scheduleId);
  const normalized = await normalizedScheduleInput(userId, input);
  await prisma.schedule.update({
    where: { id: scheduleId },
    data: {
      name: normalized.name,
      prompt: normalized.prompt,
      leadAgentKey: input.leadAgentKey,
      participantAgentKeys: normalized.dependencies.participantAgentKeys,
      attachments: input.attachments as unknown as Prisma.InputJsonArray,
      model: normalized.model,
      autoApprovePermissions: normalized.autoApprovePermissions,
      frequency: frequencyEnum(normalized.rule.frequency),
      localTime: normalized.rule.localTime,
      weekday: normalized.rule.weekday,
      onceAt: normalized.rule.onceAt ? new Date(normalized.rule.onceAt) : null,
      cronExpression: normalized.rule.cronExpression,
      nextRunAt: normalized.rule.nextRunAt,
      status: existing.status === ScheduleStatus.COMPLETED
        ? ScheduleStatus.ACTIVE
        : existing.status,
      statusReason: existing.status === ScheduleStatus.PAUSED
        ? existing.statusReason ?? "由你暂停"
        : null,
    },
  });
  return getSchedule(userId, scheduleId);
}

export async function deleteSchedule(userId: string, scheduleId: string) {
  try {
    await prisma.$transaction(async (tx) => {
      const schedule = await tx.schedule.findFirst({
        where: { id: scheduleId, userId },
        select: { id: true },
      });
      if (!schedule) throw new ScheduleServiceError("定时任务不存在", 404);

      const activeExecution = await tx.execution.findFirst({
        where: {
          scheduleRun: { scheduleId: schedule.id },
          status: {
            in: [
              ExecutionStatus.QUEUED,
              ExecutionStatus.DISPATCHING,
              ExecutionStatus.RUNNING,
              ExecutionStatus.WAITING_INPUT,
              ExecutionStatus.INTERRUPTED,
            ],
          },
        },
        select: { id: true },
      });
      if (activeExecution) {
        throw new ScheduleServiceError(
          "任务仍有未完成或待核对的执行，请在对应对话中完成、取消或核对后再删除",
          409,
        );
      }

      await tx.schedule.delete({ where: { id: schedule.id } });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
      throw new ScheduleServiceError("任务状态刚刚发生变化，请重试删除", 409);
    }
    throw error;
  }
}

export async function pauseSchedule(userId: string, scheduleId: string) {
  const schedule = await requireOwnedSchedule(userId, scheduleId);
  if (schedule.status === ScheduleStatus.COMPLETED) {
    throw new ScheduleServiceError("一次任务已经完成，编辑时间后可以再次启用", 409);
  }
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.schedule.update({
      where: { id: schedule.id },
      data: { status: ScheduleStatus.PAUSED, statusReason: "由你暂停" },
    });
    await tx.execution.updateMany({
      where: {
        status: "QUEUED",
        scheduleRun: { scheduleId: schedule.id },
      },
      data: { status: "CANCELLED", error: "定时任务已暂停", finishedAt: now },
    });
  });
  return getSchedule(userId, scheduleId);
}

export async function resumeSchedule(userId: string, scheduleId: string) {
  const schedule = await requireOwnedSchedule(userId, scheduleId);
  await validateDependencies(
    userId,
    schedule.leadAgentKey,
    jsonStringArray(schedule.participantAgentKeys),
  );
  await validateConversationAttachments(userId, jsonAttachments(schedule.attachments));
  const nextRunAt = (() => {
    try {
      return normalizeScheduleRule({
        frequency: frequencyValue(schedule.frequency),
        localTime: schedule.localTime,
        ...(schedule.frequency === ScheduleFrequency.ONCE
          ? { localDate: localDate(schedule.onceAt) ?? "" }
          : {}),
        ...(schedule.frequency === ScheduleFrequency.WEEKLY
          ? { weekday: schedule.weekday ?? 0 }
          : {}),
        ...(schedule.frequency === ScheduleFrequency.CRON
          ? { cronExpression: schedule.cronExpression ?? "" }
          : {}),
      } as ScheduleInput["rule"]).nextRunAt;
    } catch (error) {
      throw new ScheduleServiceError(error instanceof Error ? error.message : "执行时间不正确");
    }
  })();
  await prisma.schedule.update({
    where: { id: schedule.id },
    data: { status: ScheduleStatus.ACTIVE, statusReason: null, nextRunAt },
  });
  return getSchedule(userId, scheduleId);
}

export async function runScheduleNow(userId: string, scheduleId: string, requestKey: string) {
  const schedule = await requireOwnedSchedule(userId, scheduleId);
  if (schedule.status === ScheduleStatus.PAUSED) {
    throw new ScheduleServiceError("暂停的任务不能立即运行", 409);
  }
  const { assignments, container } = await validateDependencies(
    userId,
    schedule.leadAgentKey,
    jsonStringArray(schedule.participantAgentKeys),
  );
  await validateConversationAttachments(userId, jsonAttachments(schedule.attachments));
  const normalizedRequestKey = `schedule-manual:${requestKey}`;
  const existing = await prisma.execution.findUnique({
    where: { userId_requestKey: { userId, requestKey: normalizedRequestKey } },
    include: { scheduleRun: true },
  });
  if (existing) {
    if (existing.scheduleRun?.scheduleId !== schedule.id) {
      throw new ScheduleServiceError("重复请求标识对应了另一项任务", 409);
    }
    return {
      runId: existing.scheduleRunId!,
      executionId: existing.id,
      conversationId: existing.conversationId,
    };
  }
  const now = new Date();
  const snapshot = scheduleSnapshot(schedule);
  let result;
  try {
    result = await prisma.$transaction(async (tx) => {
      const run = await tx.scheduleRun.create({
        data: {
          scheduleId: schedule.id,
          userId,
          scheduledFor: now,
          trigger: ScheduleRunTrigger.MANUAL,
          decision: ScheduleRunDecision.ENQUEUED,
          scheduleSnapshot: snapshot as unknown as Prisma.InputJsonObject,
        },
      });
      const conversation = await tx.conversation.create({
        data: {
          userId,
          title: `立即执行 · ${schedule.name}`.slice(0, 120),
          lastAgentKey: schedule.leadAgentKey,
          lastConfigGeneration: container!.appliedGeneration,
        },
      });
      const execution = await tx.execution.create({
        data: {
          userId,
          conversationId: conversation.id,
          scheduleRunId: run.id,
          source: "SCHEDULE_MANUAL",
          requestKey: normalizedRequestKey,
          leadAgentKey: schedule.leadAgentKey,
          agentKeysSnapshot: assignments.map(({ agent }) => agent.key),
          configGeneration: container!.appliedGeneration,
          inputText: schedule.prompt,
          attachments: schedule.attachments as Prisma.InputJsonValue,
          model: schedule.model,
          autoApprovePermissions: schedule.autoApprovePermissions,
          promptMarker: randomUUID(),
        },
      });
      return { run, conversation, execution };
    });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
      throw error;
    }
    const duplicate = await prisma.execution.findUnique({
      where: { userId_requestKey: { userId, requestKey: normalizedRequestKey } },
      include: { scheduleRun: true },
    });
    if (!duplicate || duplicate.scheduleRun?.scheduleId !== schedule.id) throw error;
    return {
      runId: duplicate.scheduleRunId!,
      executionId: duplicate.id,
      conversationId: duplicate.conversationId,
    };
  }
  kickExecutionLoop();
  return {
    runId: result.run.id,
    executionId: result.execution.id,
    conversationId: result.conversation.id,
  };
}

export async function pauseInvalidSchedulesForUser(userId: string) {
  const [assignments, schedules] = await Promise.all([
    availableAgents(userId),
    prisma.schedule.findMany({ where: { userId, status: ScheduleStatus.ACTIVE } }),
  ]);
  const agents = new Map(assignments.map(({ agent }) => [agent.key, agent]));
  const affected = schedules.filter((schedule) =>
    !agents.has(schedule.leadAgentKey) ||
    agents.get(schedule.leadAgentKey)?.mode === "subagent" ||
    jsonStringArray(schedule.participantAgentKeys)
      .some((key) => !agents.has(key) || agents.get(key)?.mode === "primary"),
  );
  if (!affected.length) return 0;
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.schedule.updateMany({
      where: { id: { in: affected.map((item) => item.id) } },
      data: {
        status: ScheduleStatus.PAUSED,
        statusReason: "所需智能体已不可用或角色模式不匹配，请调整后再恢复",
      },
    });
    await tx.execution.updateMany({
      where: {
        status: "QUEUED",
        scheduleRun: { scheduleId: { in: affected.map((item) => item.id) } },
      },
      data: {
        status: "CANCELLED",
        error: "所需智能体已被撤销或停用",
        finishedAt: now,
      },
    });
  });
  return affected.length;
}
