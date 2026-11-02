import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import {
  ExecutionSource,
  ExecutionStatus,
  type ContainerInstance,
  type Conversation,
  type Execution,
  Prisma,
} from "@prisma/client";
import type {
  CollaborationSnapshot,
  ConversationAttachment,
  ConversationCollaboration,
  ConversationPermission,
  ConversationQuestion,
  ConversationSnapshot,
  ConversationSummary,
  ConversationsResponse,
  ForkConversationResponse,
  ExecutionSummary,
  AgentMode,
} from "@opshelper/shared";
import { lookup as mimeLookup } from "mime-types";

import {
  getActiveContainerRuntime,
  getContainerByUserId,
  getContainerProxyTarget,
  isContainerRuntimeRunning,
  startContainerByUserId,
} from "./container-service";
import { loadConfig } from "./config";
import { currentExecutionMessages, latestCurrentAssistant, isFinalAssistant } from "./execution-observation";
import { ConversationTextProjector, conversationEventFrame, readRuntimeEvents } from "./conversation-events";
import { resolveUserPathSafe } from "./file-service";
import { runtimeAuthorization, type ManagedRuntime } from "./managed-runtime";
import { prisma } from "./prisma";
import { normalizeV2Messages, normalizeV2Form, normalizeV2Event, v2FormAnswer, v2List, v2Request, RuntimeRequestError } from "./opencode-v2";
import { withUserConfigLock } from "./user-config-lock";

const config = loadConfig();
const activeStatuses: ExecutionStatus[] = [
  ExecutionStatus.DISPATCHING,
  ExecutionStatus.RUNNING,
  ExecutionStatus.WAITING_INPUT,
];
const finishedStatuses: ExecutionStatus[] = [
  ExecutionStatus.SUCCEEDED,
  ExecutionStatus.FAILED,
  ExecutionStatus.CANCELLED,
  ExecutionStatus.INTERRUPTED,
];
const executionMarkerPrefix = "opshelper-execution:";
const leaseDurationMs = 5 * 60 * 1000;
const maxSummaryLength = 1200;
// 执行结果会在定时任务页的结果弹窗里直接展示，保留回答正文而不是短摘要。
const maxResultLength = 8_000;
const maxCollaborators = 24;

function findLastItem<T>(items: T[], predicate: (item: T) => boolean): T | undefined {
  for (let index = items.length - 1; index >= 0; index--) {
    if (predicate(items[index])) return items[index];
  }
  return undefined;
}

export class ConversationServiceError extends Error {
  constructor(message: string, public statusCode = 400) {
    super(message);
  }
}

interface RuntimeConnection {
  container: ContainerInstance;
  runtime: ManagedRuntime;
  target: string;
  authorization: string;
}

interface RuntimeSession {
  id: string;
  title?: string;
  parentID?: string;
  [key: string]: unknown;
}

interface RuntimeRequest {
  id: string;
  sessionID?: string;
  sessionId?: string;
  [key: string]: unknown;
}

interface RuntimeConversationState {
  rootMessages: unknown[];
  children: Array<{
    session: RuntimeSession;
    messages: unknown[];
    status: string;
  }>;
  statuses: Record<string, { type?: string }>;
  questions: RuntimeRequest[];
  permissions: RuntimeRequest[];
  sessionIds: Set<string>;
}

function statusValue(status: ExecutionStatus): ExecutionSummary["status"] {
  return status.toLowerCase() as ExecutionSummary["status"];
}

function asStringArray(value: Prisma.JsonValue): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function asAttachments(value: Prisma.JsonValue): ConversationAttachment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || Array.isArray(item) || typeof item !== "object") return [];
    const record = item as Record<string, Prisma.JsonValue>;
    return typeof record.path === "string" &&
      typeof record.filename === "string" &&
      typeof record.mime === "string"
      ? [{ path: record.path, filename: record.filename, mime: record.mime }]
      : [];
  });
}

export function executionPromptMarker(marker: string) {
  return `<!-- ${executionMarkerPrefix}${marker} -->`;
}

export function executionUsesOutputDirectory(inputText: string, source: ExecutionSource) {
  return source !== ExecutionSource.CHAT && inputText.includes("{{output_dir}}");
}

export function resolveExecutionPromptText(
  inputText: string,
  source: ExecutionSource,
  executionId: string,
) {
  if (!executionUsesOutputDirectory(inputText, source)) return inputText;
  return inputText.replaceAll("{{output_dir}}", `outputs/${executionId}`);
}

export function executionInteractionGuidance(source: ExecutionSource) {
  if (source !== ExecutionSource.CHAT) return "";
  return "平台交互要求：需要保存生成的文件或目录时，一律写入 /workspace/outputs/ 下（可自行创建子目录），不要直接写在 /workspace 根目录；用户上传的文件位于 /workspace/chat-uploads/。只有完成当前请求确实需要读取环境或执行操作时才调用工具；身份、能力和使用方式等说明性问题不要先检查工作区，请直接回答，优先控制在 3 至 6 个要点，避免重复自我介绍。平台会根据真实运行事件展示操作记录；被问及工具或技能使用情况时不得凭记忆补造未发生的调用，可提示用户查看操作记录。委派子智能体时准确保留用户原意；向智能体发送问候表示让该智能体接收并回复问候，不得擅自改写为 HTTP 请求或向外部服务发送消息。";
}

function textOfParts(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? [text] : [];
    })
    .join("\n")
    .trim();
}

function runtimeMessageInfo(message: unknown) {
  if (!message || typeof message !== "object") return null;
  const record = message as { info?: Record<string, unknown>; parts?: unknown[] };
  return {
    info: record.info ?? {},
    parts: Array.isArray(record.parts) ? record.parts : [],
  };
}

function containsMarker(message: unknown, marker: string) {
  const parsed = runtimeMessageInfo(message);
  return Boolean(parsed && textOfParts(parsed.parts).includes(executionPromptMarker(marker)));
}

function messageRole(message: unknown) {
  return runtimeMessageInfo(message)?.info.role;
}

function messageError(message: unknown) {
  return runtimeMessageInfo(message)?.info.error;
}

function assistantAfterMarker(messages: unknown[], marker: string) {
  return latestCurrentAssistant(messages, executionPromptMarker(marker));
}

export interface ExecutionAnswerSource {
  id: string;
  promptMarker: string;
}

/**
 * 结果弹窗要展示模型返回给用户的回答。推理内容和内部输出路径都不面向用户，
 * 历史记录里保存的结果摘要可能包含它们，因此按对话页的规则重新提取一次。
 */
export function executionAnswerText(
  messages: unknown[],
  execution: ExecutionAnswerSource,
): string | null {
  const replies = currentExecutionMessages(messages, executionPromptMarker(execution.promptMarker));
  for (const reply of [...replies].reverse()) {
    const text = summarizeMessage(reply, maxResultLength);
    if (!text) continue;
    return redactExecutionOutputPathsInText(text, execution.id);
  }
  return null;
}

/** 执行结束后保存的结果摘要：与对话页一致，不含推理内容和内部输出路径。 */
function executionResultSummary(message: unknown, executionId: string) {
  const text = summarizeMessage(message, maxResultLength);
  return text ? redactExecutionOutputPathsInText(text, executionId) : null;
}

export function summarizeMessage(message: unknown, limit = maxSummaryLength) {
  // 推理内容不是模型返回给用户的回答，与对话页的展示规则一致。
  const parts = (runtimeMessageInfo(message)?.parts ?? []).filter(
    (part) => (part as { type?: unknown } | null)?.type !== "reasoning",
  );
  const text = textOfParts(parts);
  return text ? text.slice(0, limit) : null;
}

function sensitiveRuntimeKey(key: string) {
  return /^(authorization|proxy[-_]?authorization|cookie|set[-_]?cookie|password|passwd|secret|client[-_]?secret|api[-_]?key|token|access[-_]?token|refresh[-_]?token|private[-_]?key|credentials?)$/i.test(key);
}

function stripInternalMarkers(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replace(/\n?\n?<!-- opshelper-execution:[A-Za-z0-9-]+ -->/g, "")
      .trimEnd();
  }
  if (Array.isArray(value)) return value.map(stripInternalMarkers);
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (["sessionID", "sessionId", "parentID"].includes(key)) continue;
    output[key] = sensitiveRuntimeKey(key) ? "[已隐藏]" : stripInternalMarkers(item);
  }
  return output;
}

/**
 * Browser-visible history keeps observable tool events but never sends model
 * reasoning or the contents loaded by the skill tool. A skill invocation is
 * still represented by its name and status, so the UI can truthfully say it
 * was used without exposing the instruction package itself.
 */
function sanitizeRuntimeMessage(message: unknown) {
  const sanitized = stripInternalMarkers(message);
  if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized)) return sanitized;
  const output = sanitized as Record<string, unknown>;
  if (!Array.isArray(output.parts)) return output;
  return {
    ...output,
    parts: output.parts.flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [value];
      const part = value as Record<string, unknown>;
      if (part.type === "reasoning") return [];
      if (part.type !== "tool" || String(part.tool ?? "").toLowerCase() !== "skill") return [part];
      const state = part.state && typeof part.state === "object" && !Array.isArray(part.state)
        ? part.state as Record<string, unknown>
        : null;
      if (!state) return [part];
      const { output: _privateOutput, metadata: _privateMetadata, ...publicState } = state;
      return [{ ...part, state: publicState }];
    }),
  };
}

function redactExecutionOutputPathsInText(text: string, executionId: string) {
  return text
    .replaceAll(`/workspace/outputs/${executionId}`, "结果文件")
    .replaceAll(`outputs/${executionId}`, "结果文件");
}

function redactExecutionOutputPaths(value: unknown, executionId: string): unknown {
  if (typeof value === "string") return redactExecutionOutputPathsInText(value, executionId);
  if (Array.isArray(value)) {
    return value.map((item) => redactExecutionOutputPaths(item, executionId));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    redactExecutionOutputPaths(item, executionId),
  ]));
}

type VisibleExecutionMessage = Pick<Execution, "id" | "inputText" | "attachments" | "promptMarker">;

function visibleUserMessage(message: unknown, execution: VisibleExecutionMessage) {
  const parsed = runtimeMessageInfo(message);
  const sanitized = stripInternalMarkers(message) as Record<string, unknown>;
  const originalTextPart = parsed?.parts.find((part) => {
    if (!part || typeof part !== "object") return false;
    const record = part as Record<string, unknown>;
    return record.type === "text" || typeof record.text === "string";
  });
  const parts: Array<Record<string, unknown>> = [];

  if (execution.inputText) {
    const base = originalTextPart && typeof originalTextPart === "object"
      ? stripInternalMarkers(originalTextPart) as Record<string, unknown>
      : {};
    parts.push({
      ...base,
      id: typeof base.id === "string" ? base.id : `opshelper-input-${execution.id}`,
      type: "text",
      text: execution.inputText,
    });
  }

  asAttachments(execution.attachments).forEach((attachment, index) => {
    parts.push({
      id: `opshelper-attachment-${execution.id}-${index}`,
      type: "file",
      mime: attachment.mime,
      filename: attachment.filename,
      url: `file://${attachment.path}`,
    });
  });

  return { ...sanitized, parts };
}

/**
 * 读取一次执行的模型回答。与打开对话一致：容器未运行时按需启动；容器未就绪或会话
 * 已不在时返回 null，由调用方决定是否沿用数据库中已保存的结果摘要。
 */
export async function readExecutionAnswer(
  userId: string,
  execution: Pick<Execution, "id" | "promptMarker" | "conversationId">,
): Promise<string | null> {
  const conversation = await prisma.conversation.findFirst({
    where: { id: execution.conversationId, userId },
    select: { nativeSessionId: true },
  });
  if (!conversation?.nativeSessionId) return null;
  const connection = await connectRuntimeForRead(userId);
  const messages = await runtimeRequest<unknown[]>(
    connection,
    "GET",
    `/api/session/${conversation.nativeSessionId}/message`,
    undefined,
    15_000,
  );
  return executionAnswerText(Array.isArray(messages) ? messages : [], execution);
}

export function sanitizeRuntimeMessages(
  messages: unknown[],
  executions: VisibleExecutionMessage[] = [],
) {
  let currentExecution: VisibleExecutionMessage | undefined;
  return messages.map((message) => {
    if (messageRole(message) === "user") {
      currentExecution = executions.find((item) => containsMarker(message, item.promptMarker));
      return currentExecution
        ? visibleUserMessage(message, currentExecution)
        : stripInternalMarkers(message);
    }
    const sanitized = sanitizeRuntimeMessage(message);
    return currentExecution && messageRole(message) === "assistant"
      ? redactExecutionOutputPaths(sanitized, currentExecution.id)
      : sanitized;
  });
}

export function runtimeExecutionMarkers(messages: unknown[]) {
  return [...new Set(messages.flatMap((message) =>
    messageRole(message) === "user"
      ? [...textOfParts(runtimeMessageInfo(message)?.parts).matchAll(/<!-- opshelper-execution:([A-Za-z0-9-]+) -->/g)]
        .map((match) => match[1])
      : [],
  ))];
}

// Native forks retain prompt markers but receive new message IDs. Resolve the
// original display inputs by marker, scoped to the owner, without copying job
// records or exposing their execution state in the new conversation.
async function visibleHistoryExecutions(userId: string, messages: unknown[], executions: VisibleExecutionMessage[]) {
  const known = new Set(executions.map((execution) => execution.promptMarker));
  const missing = runtimeExecutionMarkers(messages).filter((marker) => !known.has(marker));
  if (missing.length === 0) return executions;
  const inherited = await prisma.execution.findMany({
    where: { userId, promptMarker: { in: missing } },
    select: { id: true, inputText: true, attachments: true, promptMarker: true },
  });
  return [...executions, ...inherited];
}

export function conversationForkPoint(messages: unknown[], messageId: string) {
  const index = messages.findIndex((message) => runtimeMessageInfo(message)?.info.id === messageId);
  if (index < 0 || messageRole(messages[index]) !== "user") {
    throw new ConversationServiceError("请选择当前对话中已保存的用户消息", 400);
  }
  return { index, message: messages[index] };
}

async function connectRuntime(userId: string): Promise<RuntimeConnection> {
  const container = await startContainerByUserId(userId);
  const runtime = await getActiveContainerRuntime(container);
  return {
    container,
    runtime,
    target: getContainerProxyTarget(container),
    authorization: runtimeAuthorization(runtime.password),
  };
}

async function connectExistingRuntime(userId: string): Promise<RuntimeConnection> {
  const container = await getContainerByUserId(userId);
  if (!container || !await isContainerRuntimeRunning(container)) {
    throw new Error("用户运行环境当前未运行");
  }
  const runtime = await getActiveContainerRuntime(container);
  return {
    container,
    runtime,
    target: getContainerProxyTarget(container),
    authorization: runtimeAuthorization(runtime.password),
  };
}

async function connectRuntimeForRead(userId: string) {
  return connectExistingRuntime(userId).catch(() => connectRuntime(userId));
}

async function runtimeRequest<T>(
  connection: RuntimeConnection,
  method: string,
  route: string,
  body?: unknown,
  timeoutMs = 30_000,
): Promise<T> {
  if (method === "GET" && (route === "/api/session" || /^\/api\/session\/[^/]+\/message$/.test(route))) {
    const values = await v2List(connection, route);
    return (route === "/api/session" ? values : normalizeV2Messages(values, route.split("/")[3])) as T;
  }
  const result = await v2Request<any>(connection, method, route, body, timeoutMs);
  const data = result?.data ?? result;
  if (route === "/api/session/active") return Object.fromEntries(Object.entries(data ?? {}).map(([id]) => [id, { type: "busy" }])) as T;
  if (route === "/api/form") return data.map(normalizeV2Form) as T;
  if (route === "/api/permission/request") return data.map((item: any) => ({ ...item, permission: item.action, patterns: item.resources })) as T;
  return data as T;
}

async function assignedAgents(userId: string) {
  return prisma.userAgent.findMany({
    where: {
      userId,
      agent: { isEnabled: true, checkStatus: "READY" },
    },
    include: { agent: true },
    orderBy: { agent: { displayName: "asc" } },
  });
}

export function conversationLeadAgentWhere(userId: string): Prisma.UserAgentWhereInput {
  return {
    userId,
    agent: { isEnabled: true, checkStatus: "READY", mode: { not: "subagent" } },
  };
}

async function assignedLeadAgents(userId: string) {
  return prisma.userAgent.findMany({
    where: conversationLeadAgentWhere(userId),
    include: { agent: true },
    orderBy: { agent: { displayName: "asc" } },
  });
}

export function assertConversationLeadMode(mode: string): void {
  if (mode === "subagent") {
    throw new ConversationServiceError("子智能体不能作为主智能体发起对话", 400);
  }
}

async function assertAssignedLeadAgent(userId: string, key: string) {
  const assignment = await prisma.userAgent.findFirst({
    where: {
      userId,
      agent: { key, isEnabled: true, checkStatus: "READY" },
    },
    include: { agent: true },
  });
  if (!assignment) throw new ConversationServiceError("该智能体当前未分配给你", 403);
  assertConversationLeadMode(assignment.agent.mode);
  return assignment.agent;
}

/**
 * 归档只是把对话从会话列表里隐藏，不是删除：带链接直接打开、继续发送或再次归档
 * 都仍然允许，列表过滤只由 conversationHomeWhere 负责。
 */
export function ownedConversationWhere(userId: string, conversationId: string): Prisma.ConversationWhereInput {
  return { id: conversationId, userId };
}

async function requireOwnedConversation(userId: string, conversationId: string) {
  const conversation = await prisma.conversation.findFirst({
    where: ownedConversationWhere(userId, conversationId),
  });
  if (!conversation) throw new ConversationServiceError("对话不存在", 404);
  return conversation;
}

async function requireOwnedExecution(userId: string, executionId: string) {
  const execution = await prisma.execution.findFirst({
    where: { id: executionId, userId },
    include: { conversation: true },
  });
  if (!execution) throw new ConversationServiceError("执行记录不存在", 404);
  return execution;
}

// Session permissions are replaced atomically by V2 PATCH. Deny by default;
// allow only assigned collaborators, including when resuming stored children.
export function nativeTaskPermissions(runtime: Pick<ManagedRuntime, "agentKeys" | "taskAgentKeys">) {
  return [
    { action: "subagent", resource: "*", effect: "deny" },
    ...(runtime.taskAgentKeys ?? []).map((key) => ({ action: "subagent", resource: key, effect: "allow" })),
  ];
}

async function ensureNativeSession(conversation: Conversation, connection?: RuntimeConnection) {
  if (conversation.nativeSessionId) return conversation;
  const active = connection ?? await connectRuntime(conversation.userId);
  const runtimeTitle = `opshelper:${conversation.id}`;
  const existing = await runtimeRequest<RuntimeSession[]>(active, "GET", "/api/session")
    .then((sessions) => sessions.find((session) => session.title === runtimeTitle))
    .catch(() => undefined);
  if (existing) {
    return prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        nativeSessionId: existing.id,
        recoveryRequired: false,
        recoveryReason: null,
      },
    });
  }

  const attemptId = randomUUID();
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { sessionCreateAttemptId: attemptId },
  });
  try {
    const session = await runtimeRequest<RuntimeSession>(active, "POST", "/api/session", {
      title: runtimeTitle,
      location: { directory: "/workspace" },
      agent: conversation.lastAgentKey,
      permissions: nativeTaskPermissions(active.runtime),
    }, 120_000);
    return prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        nativeSessionId: session.id,
        sessionCreateAttemptId: null,
        recoveryRequired: false,
        recoveryReason: null,
      },
    });
  } catch (error) {
    const recovered = await runtimeRequest<RuntimeSession[]>(active, "GET", "/api/session")
      .then((sessions) => sessions.find((session) => session.title === runtimeTitle))
      .catch(() => undefined);
    if (recovered) {
      return prisma.conversation.update({
        where: { id: conversation.id },
        data: {
          nativeSessionId: recovered.id,
          sessionCreateAttemptId: null,
          recoveryRequired: false,
          recoveryReason: null,
        },
      });
    }
    const reason = `原生会话创建结果无法确认：${error instanceof Error ? error.message : "未知错误"}`;
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { recoveryRequired: true, recoveryReason: reason },
    });
    throw new ConversationServiceError(reason, 503);
  }
}

function queuePositions(executions: Array<{ id: string; userId: string; status: ExecutionStatus }>) {
  const positions = new Map<string, number>();
  const byUser = new Map<string, number>();
  for (const execution of executions) {
    if (execution.status !== ExecutionStatus.QUEUED) continue;
    const next = (byUser.get(execution.userId) ?? 0) + 1;
    byUser.set(execution.userId, next);
    positions.set(execution.id, next);
  }
  return positions;
}

export function serializeExecutionSummary(execution: Execution, queuePosition: number | null): ExecutionSummary {
  return {
    id: execution.id,
    status: statusValue(execution.status),
    leadAgentKey: execution.leadAgentKey,
    agentKeys: asStringArray(execution.agentKeysSnapshot),
    actualAgentKeys: execution.actualAgentKeys ? asStringArray(execution.actualAgentKeys) : [],
    configGeneration: execution.configGeneration,
    inputText: execution.inputText,
    attachments: asAttachments(execution.attachments),
    outputFiles: execution.outputFiles ? asAttachments(execution.outputFiles) : [],
    queuePosition,
    resultSummary: execution.resultSummary,
    error: execution.error,
    queuedAt: execution.queuedAt.toISOString(),
    startedAt: execution.startedAt?.toISOString() ?? null,
    finishedAt: execution.finishedAt?.toISOString() ?? null,
    source: execution.source.toLowerCase() as ExecutionSummary["source"],
    scheduleRunId: execution.scheduleRunId,
    autoApprovePermissions: execution.autoApprovePermissions,
  };
}

function conversationSummary(
  conversation: Conversation & { executions?: Execution[] },
  positions: Map<string, number>,
): ConversationSummary {
  const latest = conversation.executions?.[0] ?? null;
  return {
    id: conversation.id,
    title: conversation.title,
    leadAgentKey: conversation.lastAgentKey,
    recoveryRequired: conversation.recoveryRequired,
    recoveryReason: conversation.recoveryReason,
    latestExecutionStatus: latest ? statusValue(latest.status) : null,
    queuePosition: latest ? positions.get(latest.id) ?? null : null,
    source: latest ? latest.source.toLowerCase() as ConversationSummary["source"] : null,
    scheduleName: latest && latest.source !== "CHAT"
      ? conversation.title.replace(/^(定时任务|立即执行)\s*·\s*/, "")
      : null,
    createdAt: conversation.createdAt.toISOString(),
    updatedAt: conversation.updatedAt.toISOString(),
  };
}

export function conversationHomeWhere(userId: string): Prisma.ConversationWhereInput {
  return {
    userId,
    archivedAt: null,
    executions: {
      none: {
        source: {
          in: [ExecutionSource.SCHEDULED, ExecutionSource.SCHEDULE_MANUAL],
        },
      },
    },
  };
}

export async function listConversationHome(userId: string): Promise<ConversationsResponse> {
  const [agents, conversations, queued, container] = await Promise.all([
    assignedLeadAgents(userId),
    prisma.conversation.findMany({
      where: conversationHomeWhere(userId),
      include: { executions: { orderBy: { createdAt: "desc" }, take: 1 } },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.execution.findMany({
      where: { userId, status: ExecutionStatus.QUEUED },
      select: { id: true, userId: true, status: true },
      orderBy: { queueSequence: "asc" },
    }),
    prisma.containerInstance.findUnique({ where: { userId } }),
  ]);
  const positions = queuePositions(queued);
  return {
    agents: agents.map(({ agent }) => ({
      key: agent.key,
      name: agent.displayName,
      description: agent.description,
      mode: agent.mode as AgentMode,
    })),
    conversations: conversations.map((conversation) => conversationSummary(conversation, positions)),
    executionBlockedReason: container?.executionRecoveryRequired
      ? container.executionRecoveryReason ?? "运行环境需要人工恢复"
      : null,
  };
}

export async function createConversation(input: {
  userId: string;
  leadAgentKey: string;
  title?: string;
}) {
  await assertAssignedLeadAgent(input.userId, input.leadAgentKey);
  const record = await prisma.containerInstance.findUnique({ where: { userId: input.userId } });
  if (!record || record.configApplyStatus !== "READY" || record.desiredGeneration !== record.appliedGeneration) {
    throw new ConversationServiceError(record?.configApplyError ?? "智能体配置尚未完成装配", 503);
  }
  if (record.executionRecoveryRequired) {
    throw new ConversationServiceError(record.executionRecoveryReason ?? "运行环境需要恢复", 503);
  }
  const conversation = await prisma.conversation.create({
    data: {
      userId: input.userId,
      title: input.title?.trim().slice(0, 120) || "新的对话",
      lastAgentKey: input.leadAgentKey,
      lastConfigGeneration: record.appliedGeneration,
    },
  });
  return ensureNativeSession(conversation);
}

export async function forkConversation(input: {
  userId: string;
  conversationId: string;
  messageId: string;
}): Promise<ForkConversationResponse> {
  // Check ownership before connecting to any user's runtime.
  await requireOwnedConversation(input.userId, input.conversationId);
  const connection = await connectRuntimeForRead(input.userId);
  let forkedSessionId: string | null = null;
  try {
    return await withUserConfigLock(input.userId, async (tx) => {
      const conversation = await tx.conversation.findFirst({
        where: ownedConversationWhere(input.userId, input.conversationId),
      });
      if (!conversation) throw new ConversationServiceError("对话不存在", 404);
      if (!conversation.nativeSessionId || conversation.recoveryRequired) {
        throw new ConversationServiceError(conversation.recoveryReason ?? "该对话尚未就绪", 409);
      }
      const assignment = await tx.userAgent.findFirst({
        where: { userId: input.userId, agent: { key: conversation.lastAgentKey, isEnabled: true, checkStatus: "READY" } },
        include: { agent: true },
      });
      if (!assignment) throw new ConversationServiceError("该智能体当前未分配给你", 403);
      assertConversationLeadMode(assignment.agent.mode);
      const container = await tx.containerInstance.findUnique({ where: { userId: input.userId } });
      if (!container || container.configApplyStatus !== "READY" || container.desiredGeneration !== container.appliedGeneration ||
        container.appliedGeneration !== connection.container.appliedGeneration || container.executionRecoveryRequired) {
        throw new ConversationServiceError("运行环境或智能体配置尚未就绪，请稍后重试", 503);
      }
      const active = await tx.execution.findFirst({
        where: { conversationId: conversation.id, status: { in: [ExecutionStatus.QUEUED, ...activeStatuses] } },
      });
      const statuses = await runtimeRequest<Record<string, { type?: string }>>(connection, "GET", "/api/session/active");
      const nativeStatus = statuses[conversation.nativeSessionId]?.type;
      if (active || (nativeStatus && nativeStatus !== "idle")) {
        throw new ConversationServiceError("请等待当前对话执行完成后再重新开始", 409);
      }
      const messages = await runtimeRequest<unknown[]>(connection, "GET", `/api/session/${conversation.nativeSessionId}/message`);
      const point = conversationForkPoint(messages, input.messageId);
      const historyExecutions = await visibleHistoryExecutions(input.userId, messages, []);
      const selected = runtimeMessageInfo(sanitizeRuntimeMessages([point.message], historyExecutions)[0]);
      const attachments: ConversationAttachment[] = (selected?.parts ?? []).flatMap((part) => {
        const file = part as Record<string, unknown>;
        if (file.type !== "file" || typeof file.url !== "string" || !file.url.startsWith("file://") ||
          typeof file.filename !== "string" || typeof file.mime !== "string") return [];
        return [{ path: file.url.slice(7), filename: file.filename, mime: file.mime }];
      });
      // OpenCode excludes messageID and everything after it. The selected
      // message becomes an editable draft; the model keeps the prior turns.
      const forked = await runtimeRequest<RuntimeSession>(connection, "POST", `/api/session/${conversation.nativeSessionId}/fork`, {
        before: input.messageId,
      });
      forkedSessionId = forked.id;
      const copied = await runtimeRequest<unknown[]>(connection, "GET", `/api/session/${forked.id}/message`);
      if (copied.length !== point.index) throw new ConversationServiceError("会话分支的历史边界无法确认", 503);
      const created = await tx.conversation.create({
        data: {
          userId: input.userId,
          nativeSessionId: forked.id,
          title: `${conversation.title.slice(0, 115)} · 分支`,
          lastAgentKey: conversation.lastAgentKey,
          lastConfigGeneration: container.appliedGeneration,
        },
      });
      await runtimeRequest(connection, "PATCH", `/api/session/${forked.id}`, {
        title: `opshelper:${created.id}`,
        permissions: nativeTaskPermissions(connection.runtime),
      });
      return {
        conversationId: created.id,
        leadAgentKey: created.lastAgentKey,
        text: textOfParts((selected?.parts ?? []).filter((part) => (part as { type?: string }).type === "text")),
        attachments,
      };
    });
  } catch (error) {
    // Only the new, uncommitted native session can be removed. The source and
    // its workspace are never reverted or changed by this action.
    if (forkedSessionId) {
      await runtimeRequest(connection, "DELETE", `/api/session/${forkedSessionId}`).catch(() => undefined);
    }
    throw error;
  }
}

async function fileDigest(path: string) {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    hash.update(buffer);
  }
  return { size, sha256: hash.digest("hex") };
}

export async function validateConversationAttachments(
  userId: string,
  attachments: ConversationAttachment[],
  includeDigests = false,
) {
  if (attachments.length > 20) throw new ConversationServiceError("一次最多添加 20 个附件");
  const digests: Array<{ path: string; size: number; sha256: string }> = [];
  for (const attachment of attachments) {
    if (!attachment.path.startsWith("/workspace/") || attachment.path.includes("\0")) {
      throw new ConversationServiceError("附件必须位于你的文件目录");
    }
    const resolved = await resolveUserPathSafe(userId, attachment.path);
    const info = await lstat(resolved).catch(() => null);
    const isDirectoryReference = attachment.mime === "inode/directory";
    if (
      !info ||
      info.isSymbolicLink() ||
      (isDirectoryReference ? !info.isDirectory() : !info.isFile())
    ) {
      throw new ConversationServiceError(`附件不存在：${attachment.filename}`);
    }
    if (includeDigests && !isDirectoryReference) {
      digests.push({ path: attachment.path, ...await fileDigest(resolved) });
    }
  }
  return digests;
}

let loopKick: (() => void) | null = null;

export async function enqueueExecution(input: {
  userId: string;
  conversationId: string;
  requestKey: string;
  leadAgentKey: string;
  text: string;
  attachments: ConversationAttachment[];
  model?: string;
  autoApprovePermissions?: boolean;
}) {
  const conversation = await requireOwnedConversation(input.userId, input.conversationId);
  const existing = await prisma.execution.findUnique({
    where: { userId_requestKey: { userId: input.userId, requestKey: input.requestKey } },
  });
  if (existing) {
    const sameAttachments = JSON.stringify(asAttachments(existing.attachments)) === JSON.stringify(input.attachments);
    if (existing.conversationId !== input.conversationId ||
      existing.leadAgentKey !== input.leadAgentKey ||
      existing.inputText !== input.text.trim() ||
      existing.model !== (input.model?.trim() || null) ||
      existing.autoApprovePermissions !== (input.autoApprovePermissions === true) ||
      !sameAttachments) {
      throw new ConversationServiceError("重复请求标识对应的任务内容不一致", 409);
    }
    return existing;
  }
  if (conversation.recoveryRequired) {
    throw new ConversationServiceError(conversation.recoveryReason ?? "该对话需要先完成恢复", 409);
  }
  await assertAssignedLeadAgent(input.userId, input.leadAgentKey);
  await validateConversationAttachments(input.userId, input.attachments);
  if (!input.text.trim() && input.attachments.length === 0) {
    throw new ConversationServiceError("请输入任务内容或添加附件");
  }
  const [agents, container] = await Promise.all([
    assignedAgents(input.userId),
    prisma.containerInstance.findUnique({ where: { userId: input.userId } }),
  ]);
  if (!container || container.configApplyStatus !== "READY" || container.desiredGeneration !== container.appliedGeneration) {
    throw new ConversationServiceError(container?.configApplyError ?? "智能体配置尚未完成装配", 503);
  }
  if (container.executionRecoveryRequired) {
    throw new ConversationServiceError(container.executionRecoveryReason ?? "运行环境需要恢复", 503);
  }
  let execution: Execution;
  try {
    execution = await prisma.$transaction(async (tx) => {
      const created = await tx.execution.create({
        data: {
          userId: input.userId,
          conversationId: conversation.id,
          requestKey: input.requestKey,
          leadAgentKey: input.leadAgentKey,
          agentKeysSnapshot: agents.map(({ agent }) => agent.key),
          configGeneration: container.appliedGeneration,
          inputText: input.text.trim(),
          attachments: input.attachments as unknown as Prisma.InputJsonArray,
          model: input.model?.trim() || null,
          autoApprovePermissions: input.autoApprovePermissions === true,
          promptMarker: randomUUID(),
        },
      });
      await tx.conversation.update({
        where: { id: conversation.id },
        data: {
          lastAgentKey: input.leadAgentKey,
          lastConfigGeneration: container.appliedGeneration,
          // 在归档的对话里继续发言就当作用户重新使用它：回到会话列表，而不是留在隐形状态。
          archivedAt: null,
          title: conversation.title === "新的对话" && input.text.trim()
            ? input.text.trim().replace(/\s+/g, " ").slice(0, 60)
            : conversation.title,
        },
      });
      return created;
    });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
      throw error;
    }
    const duplicate = await prisma.execution.findUnique({
      where: { userId_requestKey: { userId: input.userId, requestKey: input.requestKey } },
    });
    if (!duplicate) throw error;
    const sameAttachments = JSON.stringify(asAttachments(duplicate.attachments)) === JSON.stringify(input.attachments);
    if (duplicate.conversationId !== input.conversationId ||
      duplicate.leadAgentKey !== input.leadAgentKey ||
      duplicate.inputText !== input.text.trim() ||
      duplicate.model !== (input.model?.trim() || null) ||
      duplicate.autoApprovePermissions !== (input.autoApprovePermissions === true) ||
      !sameAttachments) {
      throw new ConversationServiceError("重复请求标识对应的任务内容不一致", 409);
    }
    execution = duplicate;
  }
  loopKick?.();
  return execution;
}

export function executionPromptPayload(
  execution: Pick<Execution, "id" | "inputText" | "source" | "attachments" | "promptMarker">,
  plannedCollaborators: string[] = [],
) {
  const attachments = asAttachments(execution.attachments);
  const viewable = attachments.filter((file) =>
    file.mime.startsWith("image/") || file.mime.startsWith("text/") || file.mime === "application/pdf",
  );
  let text = resolveExecutionPromptText(execution.inputText, execution.source, execution.id);
  const interactionGuidance = executionInteractionGuidance(execution.source);
  if (interactionGuidance) {
    text = `${text}${text ? "\n\n" : ""}${interactionGuidance}`;
  }
  if (attachments.length) {
    // Include the actual path even when V2 also embeds a viewable attachment.
    // Providers can otherwise ask the read tool for /workspace/<filename>.
    const lines = attachments.map((file) => `- ${file.filename}（${file.path}）`).join("\n");
    const note = `请读取并处理以下文件或文件夹：\n${lines}`;
    text = text ? `${text}\n\n${note}` : note;
  }
  if (plannedCollaborators.length) {
    text = `${text}${text ? "\n\n" : ""}本次定时任务计划由以下智能体协作：${plannedCollaborators.join("、")}。请按任务需要使用 task 工具委派，并以实际执行情况为准。`;
  }
  text = `${text}${text ? "\n\n" : ""}${executionPromptMarker(execution.promptMarker)}`;
  return {
    id: `msg_opshelper_${execution.promptMarker.replaceAll("-", "")}`,
    text,
    files: viewable.map((file) => ({ uri: `file://${file.path}`, name: file.filename })),
    delivery: "queue",
  };
}

async function markInterrupted(execution: Execution, reason: string) {
  const now = new Date();
  await prisma.$transaction([
    prisma.execution.update({
      where: { id: execution.id },
      data: { status: ExecutionStatus.INTERRUPTED, error: reason, finishedAt: now },
    }),
    prisma.conversation.update({
      where: { id: execution.conversationId },
      data: { recoveryRequired: true, recoveryReason: reason },
    }),
    prisma.containerInstance.update({
      where: { userId: execution.userId },
      data: {
        activeExecutionId: execution.id,
        executionLeaseOwner: null,
        executionLeaseExpiresAt: null,
        executionRecoveryRequired: true,
        executionRecoveryReason: reason,
      },
    }),
  ]);
}

async function finishExecution(execution: Execution, status: ExecutionStatus, result: string | null, error: string | null) {
  idleObservationSince.delete(execution.id);
  const now = new Date();
  const outputFiles = await finalizeOutputFiles(execution.userId, execution.id);
  await prisma.$transaction([
    prisma.execution.update({
      where: { id: execution.id },
      data: {
        status,
        resultSummary: result,
        error,
        waitingSince: null,
        finishedAt: now,
        outputFiles: outputFiles as unknown as Prisma.InputJsonArray,
      },
    }),
    prisma.containerInstance.updateMany({
      where: { userId: execution.userId, activeExecutionId: execution.id },
      data: {
        activeExecutionId: null,
        executionLeaseOwner: null,
        executionLeaseExpiresAt: null,
        lastActivityAt: now,
      },
    }),
    prisma.conversation.update({
      where: { id: execution.conversationId },
      data: { updatedAt: now },
    }),
  ]);
  loopKick?.();
}

async function prepareOutputDirectory(userId: string, executionId: string) {
  const runtimePath = `/workspace/outputs/${executionId}`;
  const hostPath = await resolveUserPathSafe(userId, runtimePath);
  await mkdir(hostPath, { recursive: true });
  return hostPath;
}

async function collectOutputFiles(userId: string, executionId: string) {
  const runtimePath = `/workspace/outputs/${executionId}`;
  const root = await resolveUserPathSafe(userId, runtimePath);
  const rootInfo = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  });
  if (!rootInfo || !rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return [];

  const output: ConversationAttachment[] = [];
  async function walk(directory: string, relative: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const hostPath = `${directory}/${entry.name}`;
      const info = await lstat(hostPath);
      if (info.isSymbolicLink()) continue;
      const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (info.isDirectory()) {
        await walk(hostPath, nextRelative);
      } else if (info.isFile()) {
        output.push({
          path: `${runtimePath}/${nextRelative}`,
          filename: entry.name,
          mime: mimeLookup(entry.name) || "application/octet-stream",
        });
      }
    }
  }
  await walk(root, "");
  return output;
}

async function removeEmptyOutputDirectory(userId: string, executionId: string) {
  const root = await resolveUserPathSafe(userId, `/workspace/outputs/${executionId}`);
  await rm(root, { recursive: true, force: true });
}

async function finalizeOutputFiles(userId: string, executionId: string) {
  try {
    const outputFiles = await collectOutputFiles(userId, executionId);
    if (outputFiles.length === 0) await removeEmptyOutputDirectory(userId, executionId);
    return outputFiles;
  } catch {
    return [];
  }
}

export async function pruneEmptyExecutionOutputDirectories() {
  const executions = await prisma.execution.findMany({
    where: {
      status: {
        in: [ExecutionStatus.SUCCEEDED, ExecutionStatus.FAILED, ExecutionStatus.CANCELLED],
      },
    },
    select: { id: true, userId: true, outputFiles: true },
  });
  let removed = 0;
  for (const execution of executions) {
    if (execution.outputFiles && asAttachments(execution.outputFiles).length > 0) continue;
    try {
      const root = await resolveUserPathSafe(
        execution.userId,
        `/workspace/outputs/${execution.id}`,
      );
      const info = await lstat(root);
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      if ((await collectOutputFiles(execution.userId, execution.id)).length > 0) continue;
      await removeEmptyOutputDirectory(execution.userId, execution.id);
      removed += 1;
    } catch {
      // Best-effort startup cleanup: preserve service availability if one user path is unreadable.
      continue;
    }
  }
  return removed;
}

async function runtimeState(connection: RuntimeConnection, rootSessionId: string): Promise<RuntimeConversationState> {
  const [sessions, statuses, questions, permissions, rootMessages] = await Promise.all([
    runtimeRequest<RuntimeSession[]>(connection, "GET", "/api/session"),
    runtimeRequest<Record<string, { type?: string }>>(connection, "GET", "/api/session/active"),
    runtimeRequest<RuntimeRequest[]>(connection, "GET", "/api/form"),
    runtimeRequest<RuntimeRequest[]>(connection, "GET", "/api/permission/request"),
    runtimeRequest<unknown[]>(connection, "GET", `/api/session/${rootSessionId}/message`),
  ]);
  const byParent = new Map<string, RuntimeSession[]>();
  for (const session of sessions) {
    if (!session.parentID) continue;
    const list = byParent.get(session.parentID) ?? [];
    list.push(session);
    byParent.set(session.parentID, list);
  }
  const descendants: RuntimeSession[] = [];
  const queue = [...(byParent.get(rootSessionId) ?? [])];
  const seen = new Set<string>();
  while (queue.length && descendants.length < maxCollaborators) {
    const session = queue.shift()!;
    if (seen.has(session.id)) continue;
    seen.add(session.id);
    descendants.push(session);
    queue.push(...(byParent.get(session.id) ?? []));
  }
  const children = await Promise.all(descendants.map(async (session) => ({
    session,
    messages: await runtimeRequest<unknown[]>(connection, "GET", `/api/session/${session.id}/message`).catch(() => []),
    status: statuses[session.id]?.type ?? "idle",
  })));
  const sessionIds = new Set([rootSessionId, ...descendants.map((session) => session.id)]);
  const belongs = (request: RuntimeRequest) => {
    const sessionId = request.sessionID ?? request.sessionId;
    return Boolean(sessionId && sessionIds.has(sessionId));
  };
  return {
    rootMessages,
    children,
    statuses,
    questions: Array.isArray(questions) ? questions.filter(belongs) : [],
    permissions: Array.isArray(permissions) ? permissions.filter(belongs) : [],
    sessionIds,
  };
}

export function pendingQuestion(state: RuntimeConversationState): ConversationQuestion | null {
  const item = state.questions[0];
  if (!item || !Array.isArray(item.questions)) return null;
  return {
    id: item.id,
    questions: item.questions.flatMap((question) => {
      if (!question || typeof question !== "object" || Array.isArray(question)) return [];
      const row = question as Record<string, unknown>;
      const options = Array.isArray(row.options)
        ? row.options.flatMap((option) => {
          if (typeof option === "string") return [{ label: option }];
          if (!option || typeof option !== "object" || Array.isArray(option)) return [];
          const value = option as Record<string, unknown>;
          const label = value.label ?? value.value ?? value.title ?? value.text;
          return label == null ? [] : [{
            label: String(label),
            ...(typeof value.description === "string" ? { description: value.description } : {}),
          }];
        })
        : [];
      return [{
        ...(typeof row.header === "string" ? { header: row.header } : {}),
        question: String(row.question ?? row.header ?? row.prompt ?? "请确认"),
        options,
        multiple: Boolean(row.multiple ?? row.multiSelect),
        custom: Boolean(row.custom ?? row.allowCustom ?? true),
      }];
    }),
  };
}

function pendingPermissions(state: RuntimeConversationState): ConversationPermission[] {
  return state.permissions.map((permission) => {
    const metadata = permission.metadata && typeof permission.metadata === "object" && !Array.isArray(permission.metadata)
      ? permission.metadata as Record<string, unknown>
      : {};
    const patterns = Array.isArray(permission.patterns)
      ? permission.patterns.filter((value): value is string => typeof value === "string")
      : [];
    const detail = metadata.command ?? metadata.cmd ?? metadata.path ?? metadata.filePath ?? patterns.join("\n");
    const tool = typeof permission.permission === "string" ? permission.permission : undefined;
    return {
      id: permission.id,
      title: String(metadata.description ?? tool ?? "请求授权"),
      ...(tool ? { tool } : {}),
      ...(typeof detail === "string" && detail ? { detail } : {}),
    };
  });
}

function collaborations(state: RuntimeConversationState): ConversationCollaboration[] {
  return state.children.map(({ session, messages, status }) => {
    const assistantMessages = messages.filter((message) => messageRole(message) === "assistant");
    const latest = assistantMessages.at(-1);
    const agent = findLastItem(
      assistantMessages.map((message) => runtimeMessageInfo(message)?.info.agent),
      (value): value is string => typeof value === "string",
    );
    const error = messages.some((message) => Boolean(messageError(message)));
    const sessionWaiting = [...state.questions, ...state.permissions].some((request) =>
      (request.sessionID ?? request.sessionId) === session.id,
    );
    return {
      traceId: createHash("sha256").update(session.id).digest("hex").slice(0, 12),
      agentKey: typeof agent === "string" ? agent : "协作智能体",
      title: typeof session.title === "string" ? session.title : "协作任务",
      status: error ? "failed" : sessionWaiting ? "waiting_input" : status === "busy" ? "running" : "completed",
      summary: latest ? summarizeMessage(latest) : null,
    };
  });
}

function scopeExecutionState(state: RuntimeConversationState, execution: Execution, rootId: string): RuntimeConversationState {
  const messages = currentExecutionMessages(state.rootMessages, executionPromptMarker(execution.promptMarker));
  const sessionIds = new Set([rootId]);
  const includeTaskSessions = (items: unknown[]) => {
    for (const item of items) {
      for (const raw of runtimeMessageInfo(item)?.parts ?? []) {
        const part = raw as { tool?: string; state?: { metadata?: { sessionId?: string } }; metadata?: { sessionId?: string } };
        if (part.tool !== "task") continue;
        const id = part.state?.metadata?.sessionId ?? part.metadata?.sessionId;
        if (id) sessionIds.add(id);
      }
    }
  };
  includeTaskSessions(messages);
  let previousSize = 0;
  while (previousSize !== sessionIds.size) {
    previousSize = sessionIds.size;
    for (const child of state.children) {
      if (sessionIds.has(child.session.id)) includeTaskSessions(child.messages);
    }
  }
  const children = state.children.filter((child) => sessionIds.has(child.session.id));
  const messageIds = new Set([...messages, ...children.flatMap((child) => child.messages)]
    .map((message) => runtimeMessageInfo(message)?.info.id));
  const belongs = (request: RuntimeRequest) => {
    const id = request.sessionID ?? request.sessionId;
    const tool = request.tool as { messageID?: string } | undefined;
    return Boolean(id && sessionIds.has(id) && (!tool?.messageID || messageIds.has(tool.messageID)));
  };
  return { ...state, children, sessionIds, questions: state.questions.filter(belongs), permissions: state.permissions.filter(belongs) };
}

const autoPermissionReplies = new Map<string, Promise<boolean>>();

export async function autoApprovePermissionRequests(input: {
  executionId: string;
  permissions: Array<{ id: string; sessionID?: string; sessionId?: string }>;
  allowedSessionIds: ReadonlySet<string>;
  reply: (sessionId: string, permissionId: string) => Promise<void>;
  retryDelaysMs?: number[];
}) {
  const retryDelaysMs = input.retryDelaysMs ?? [0, 250, 1_000];
  let resolved = 0;
  let failed = 0;
  for (const permission of input.permissions) {
    const sessionId = permission.sessionID ?? permission.sessionId;
    if (!sessionId || !input.allowedSessionIds.has(sessionId)) continue;
    const key = `${input.executionId}:${permission.id}`;
    let pending = autoPermissionReplies.get(key);
    if (!pending) {
      pending = (async () => {
        for (const delay of retryDelaysMs) {
          if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
          try {
            await input.reply(sessionId, permission.id);
            return true;
          } catch (error) {
            // A manual click or another observer may have won the race. A 404
            // means the request is no longer pending and therefore needs no retry.
            if (error instanceof RuntimeRequestError && error.statusCode === 404) return true;
          }
        }
        return false;
      })().finally(() => autoPermissionReplies.delete(key));
      autoPermissionReplies.set(key, pending);
    }
    if (await pending) resolved += 1;
    else failed += 1;
  }
  return { resolved, failed };
}

async function autoApprovePendingPermissions(
  execution: Execution,
  connection: RuntimeConnection,
  state: RuntimeConversationState,
  rootSessionId: string,
) {
  if (!execution.autoApprovePermissions || state.permissions.length === 0) return state;
  const outcome = await autoApprovePermissionRequests({
    executionId: execution.id,
    permissions: state.permissions,
    allowedSessionIds: state.sessionIds,
    reply: (sessionId, permissionId) => runtimeRequest(
      connection,
      "POST",
      `/api/session/${sessionId}/permission/${permissionId}/reply`,
      { decision: "once" },
      5_000,
    ),
  });
  if (outcome.resolved === 0) return state;
  return scopeExecutionState(
    await runtimeState(connection, rootSessionId),
    execution,
    rootSessionId,
  );
}

const idleObservationSince = new Map<string, number>();

async function observeExecution(execution: Execution, connection?: RuntimeConnection) {
  const conversation = await prisma.conversation.findUniqueOrThrow({ where: { id: execution.conversationId } });
  if (!conversation.nativeSessionId) {
    await markInterrupted(execution, "原生会话标识缺失，无法确认本次执行是否已发送");
    return null;
  }
  const active = connection ?? await connectExistingRuntime(execution.userId);
  let state = scopeExecutionState(await runtimeState(active, conversation.nativeSessionId), execution, conversation.nativeSessionId);
  state = await autoApprovePendingPermissions(execution, active, state, conversation.nativeSessionId);
  const actualAgentKeys = Array.from(new Set(
    collaborations(state)
      .map((item) => item.agentKey)
      .filter((key) => key && key !== "协作智能体"),
  )).sort();
  if (JSON.stringify(actualAgentKeys) !== JSON.stringify(asStringArray(execution.actualAgentKeys ?? []))) {
    await prisma.execution.update({
      where: { id: execution.id },
      data: { actualAgentKeys },
    });
  }
  const markerSeen = state.rootMessages.some((message) => containsMarker(message, execution.promptMarker));
  const assistant = assistantAfterMarker(state.rootMessages, execution.promptMarker);
  const busy = Array.from(state.sessionIds).some((id) => state.statuses[id]?.type === "busy");
  const waiting = state.questions.length > 0 || state.permissions.length > 0;
  const errorMessage = currentExecutionMessages(state.rootMessages, executionPromptMarker(execution.promptMarker))
    .find((message) => Boolean(messageError(message)));

  if (execution.status === ExecutionStatus.DISPATCHING) {
    if (markerSeen) {
      await prisma.execution.update({
        where: { id: execution.id },
        data: {
          status: waiting ? ExecutionStatus.WAITING_INPUT : ExecutionStatus.RUNNING,
          promptAcceptedAt: execution.promptAcceptedAt ?? new Date(),
          waitingSince: waiting ? execution.waitingSince ?? new Date() : null,
        },
      });
    }
    return state;
  }

  if (waiting) {
    idleObservationSince.delete(execution.id);
    await prisma.$transaction([
      prisma.execution.update({
        where: { id: execution.id },
        data: {
          status: ExecutionStatus.WAITING_INPUT,
          waitingSince: execution.waitingSince ?? new Date(),
        },
      }),
      prisma.containerInstance.update({
        where: { userId: execution.userId },
        data: { executionLeaseExpiresAt: new Date(Date.now() + leaseDurationMs) },
      }),
    ]);
    return state;
  }

  if (busy) {
    idleObservationSince.delete(execution.id);
    await prisma.$transaction([
      prisma.execution.update({
        where: { id: execution.id },
        data: { status: ExecutionStatus.RUNNING, waitingSince: null },
      }),
      prisma.containerInstance.update({
        where: { userId: execution.userId },
        data: { executionLeaseExpiresAt: new Date(Date.now() + leaseDurationMs) },
      }),
    ]);
    return state;
  }

  if (execution.cancelRequestedAt) {
    await finishExecution(execution, ExecutionStatus.CANCELLED, null, null);
  } else if (errorMessage) {
    await finishExecution(
      execution,
      ExecutionStatus.FAILED,
      executionResultSummary(assistant, execution.id),
      "模型或工具返回错误",
    );
  } else if (assistant && isFinalAssistant(assistant)) {
    await finishExecution(execution, ExecutionStatus.SUCCEEDED, executionResultSummary(assistant, execution.id), null);
  } else {
    const firstIdle = idleObservationSince.get(execution.id) ?? Date.now();
    idleObservationSince.set(execution.id, firstIdle);
    if (Date.now() - firstIdle > 10_000) {
      idleObservationSince.delete(execution.id);
      await markInterrupted(execution, "运行环境已空闲，但没有本轮完整回答；未自动重发，请核对执行状态");
    }
  }
  return state;
}

export async function claimNextExecution() {
  const candidateIds = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT ranked."id"
    FROM (
      SELECT "id", "queueSequence",
        ROW_NUMBER() OVER (PARTITION BY "userId" ORDER BY "queueSequence") AS position
      FROM "Execution"
      WHERE "status" = 'QUEUED'::"ExecutionStatus"
    ) AS ranked
    WHERE ranked.position = 1
    ORDER BY ranked."queueSequence"
    LIMIT 128
  `);
  const candidates = await prisma.execution.findMany({
    where: { id: { in: candidateIds.map((item) => item.id) } },
    orderBy: { queueSequence: "asc" },
  });
  for (const candidate of candidates) {
    const claimed = await withUserConfigLock(candidate.userId, async (tx) => {
      const [active, container, current] = await Promise.all([
        tx.execution.findFirst({
          where: { userId: candidate.userId, status: { in: activeStatuses } },
        }),
        tx.containerInstance.findUnique({ where: { userId: candidate.userId } }),
        tx.execution.findUnique({ where: { id: candidate.id } }),
      ]);
      if (active || current?.status !== ExecutionStatus.QUEUED || !container || container.activeExecutionId) return null;
      if (container.executionRecoveryRequired) return null;
      if (container.configApplyStatus !== "READY" || container.desiredGeneration !== container.appliedGeneration) {
        return null;
      }
      const currentAgents = current.source === "CHAT"
        ? null
        : await tx.userAgent.findMany({
            where: { userId: candidate.userId, agent: { isEnabled: true, checkStatus: "READY" } },
            include: { agent: true },
          });
      const leaseOwner = randomUUID();
      // Pause/cancel can commit after the queue read without taking the user
      // config lock. Claim only if this execution is still queued.
      const claimed = await tx.execution.updateMany({
        where: { id: candidate.id, status: ExecutionStatus.QUEUED },
        data: {
          status: ExecutionStatus.DISPATCHING,
          dispatchAttemptId: randomUUID(),
          startedAt: new Date(),
          ...(currentAgents ? {
            configGeneration: container.appliedGeneration,
            agentKeysSnapshot: currentAgents.map(({ agent }) => agent.key).sort(),
          } : {}),
        },
      });
      if (claimed.count !== 1) return null;
      const execution = await tx.execution.findUniqueOrThrow({ where: { id: candidate.id } });
      await tx.containerInstance.update({
        where: { userId: candidate.userId },
        data: {
          activeExecutionId: candidate.id,
          executionLeaseOwner: leaseOwner,
          executionLeaseExpiresAt: new Date(Date.now() + leaseDurationMs),
        },
      });
      return execution;
    });
    if (claimed) return claimed;
  }
  return null;
}

async function dispatchExecution(execution: Execution) {
  let deliveryAttempted = false;
  try {
    const current = await withUserConfigLock(execution.userId, async (tx) => {
      const current = await tx.execution.findUnique({ where: { id: execution.id } });
      const container = await tx.containerInstance.findUnique({ where: { userId: execution.userId } });
      if (!current || current.status !== ExecutionStatus.DISPATCHING) return null;
      if (!container || container.configApplyStatus !== "READY" ||
        container.desiredGeneration !== current.configGeneration ||
        container.appliedGeneration !== current.configGeneration) {
        throw new ConversationServiceError("排队期间智能体配置已变化，请重新提交", 409);
      }
      return current;
    });
    if (!current) return;

    let plannedCollaborators: string[] = [];
    if (current.scheduleRunId) {
      const run = await prisma.scheduleRun.findUnique({
        where: { id: current.scheduleRunId },
        include: { schedule: true },
      });
      if (!run || run.schedule.status === "PAUSED") {
        throw new ConversationServiceError("定时任务已暂停，排队执行不再启动", 409);
      }
      const raw = run.scheduleSnapshot;
      const snapshot = raw && !Array.isArray(raw) && typeof raw === "object"
        ? raw as Record<string, Prisma.JsonValue>
        : null;
      plannedCollaborators = snapshot
        ? asStringArray(snapshot.participantAgentKeys ?? [])
        : [];
      const required = [current.leadAgentKey, ...plannedCollaborators];
      const currentAssignments = await assignedAgents(current.userId);
      const available = new Map(currentAssignments.map(({ agent }) => [agent.key, agent]));
      const invalid = required.find((key, index) => {
        const agent = available.get(key);
        return !agent || (index === 0 ? agent.mode === "subagent" : agent.mode === "primary");
      });
      if (invalid) {
        await prisma.schedule.update({
          where: { id: run.scheduleId },
          data: {
            status: "PAUSED",
            statusReason: `所需智能体「${invalid}」已不可用或角色模式不匹配，请调整后再恢复`,
          },
        });
        throw new ConversationServiceError(`所需智能体「${invalid}」已不可用或角色模式不匹配`, 409);
      }
    }

    const attachmentDigests = await validateConversationAttachments(
      current.userId,
      asAttachments(current.attachments),
      true,
    );
    await prisma.execution.update({
      where: { id: current.id },
      data: { attachmentDigests },
    });
    if (executionUsesOutputDirectory(current.inputText, current.source)) {
      await prepareOutputDirectory(current.userId, current.id);
    }

    // The activeExecutionId slot is already durable. Docker and HTTP calls stay
    // outside the database transaction, so a slow container never holds a DB
    // connection or row lock. Assignment changes see the slot and either drain
    // it or request cancellation before replacing the runtime.
    const connection = await connectRuntime(execution.userId);
    if (!connection.runtime.agentKeys.includes(current.leadAgentKey)) {
      throw new ConversationServiceError("主智能体已不在当前运行环境中", 409);
    }
    const availableModels = connection.runtime.configuredModels ?? [connection.runtime.model];
    if (current.model && !availableModels.includes(current.model)) {
      throw new ConversationServiceError("所选模型不在当前运行环境的配置中", 409);
    }
    const conversation = await requireOwnedConversation(execution.userId, execution.conversationId);
    const readyConversation = await ensureNativeSession(conversation, connection);
    await runtimeRequest(connection, "PATCH", `/api/session/${readyConversation.nativeSessionId}`, {
      permissions: nativeTaskPermissions(connection.runtime),
    });
    await runtimeRequest(connection, "POST", `/api/session/${readyConversation.nativeSessionId}/agent`, { agent: current.leadAgentKey });
    const selectedModel = current.model ?? connection.runtime.model;
    const slash = selectedModel.indexOf("/");
    await runtimeRequest(connection, "POST", `/api/session/${readyConversation.nativeSessionId}/model`, {
      model: { providerID: selectedModel.slice(0, slash), id: selectedModel.slice(slash + 1) },
    });

    const stillCurrent = await withUserConfigLock(execution.userId, async (tx) => {
      const [latestExecution, latestContainer] = await Promise.all([
        tx.execution.findUnique({ where: { id: current.id } }),
        tx.containerInstance.findUnique({ where: { userId: execution.userId } }),
      ]);
      return Boolean(
        latestExecution?.status === ExecutionStatus.DISPATCHING &&
        latestContainer?.activeExecutionId === current.id &&
        latestContainer.configApplyStatus === "READY" &&
        latestContainer.appliedGeneration === current.configGeneration,
      );
    });
    if (!stillCurrent) {
      throw new ConversationServiceError("发送前配置已变化，本次请求未发送", 409);
    }

    deliveryAttempted = true;
    await runtimeRequest(
      connection,
      "POST",
      `/api/session/${readyConversation.nativeSessionId}/prompt`,
      executionPromptPayload(current, plannedCollaborators),
      120_000,
    );
    await prisma.execution.updateMany({
      where: { id: current.id, status: ExecutionStatus.DISPATCHING },
      data: { status: ExecutionStatus.RUNNING, promptAcceptedAt: new Date() },
    });
  } catch (error) {
    const current = await prisma.execution.findUnique({ where: { id: execution.id } });
    if (!current || finishedStatuses.includes(current.status)) return;
    if (!deliveryAttempted) {
      const conversation = await prisma.conversation.findUnique({
        where: { id: current.conversationId },
        select: { recoveryRequired: true, recoveryReason: true },
      });
      if (conversation?.recoveryRequired) {
        await markInterrupted(
          current,
          conversation.recoveryReason ?? "原生会话创建结果无法确认",
        );
        return;
      }
      await finishExecution(
        current,
        ExecutionStatus.FAILED,
        null,
        error instanceof Error ? error.message : "消息发送前检查失败",
      );
      return;
    }
    try {
      const connection = await connectRuntimeForRead(execution.userId);
      const state = await observeExecution(current, connection);
      if (state?.rootMessages.some((message) => containsMarker(message, current.promptMarker))) return;
    } catch {
      // The result remains unknown; markInterrupted below preserves the safe boundary.
    }
    await markInterrupted(
      current,
      `消息发送结果无法确认：${error instanceof Error ? error.message : "未知错误"}`,
    );
  }
}

async function monitorActiveExecutions() {
  const executions = await prisma.execution.findMany({
    where: { status: { in: activeStatuses } },
    orderBy: { startedAt: "asc" },
  });
  for (const execution of executions) {
    try {
      const container = await prisma.containerInstance.findUnique({ where: { userId: execution.userId } });
      if (container?.configApplyStatus === "REVOKING") {
        await abortExecution(execution.userId, execution.id);
        continue;
      }
      if (execution.status === ExecutionStatus.DISPATCHING && !execution.promptAcceptedAt) {
        // A failed read also has an uncertain delivery outcome; do not bypass
        // the dispatch deadline by falling into the outer retry catch forever.
        const state = await observeExecution(execution).catch(() => null);
        const markerSeen = Boolean(state?.rootMessages.some((message) => containsMarker(message, execution.promptMarker)));
        if (!markerSeen && execution.startedAt && Date.now() - execution.startedAt.getTime() > 15_000) {
          await markInterrupted(execution, "服务重启后无法确认消息是否已经送达，未自动重发");
        }
        continue;
      }
      if (execution.startedAt &&
        Date.now() - execution.startedAt.getTime() > config.executionTimeoutMinutes * 60_000) {
        await abortExecution(execution.userId, execution.id, true);
        continue;
      }
      if (execution.status === ExecutionStatus.WAITING_INPUT && execution.waitingSince &&
        Date.now() - execution.waitingSince.getTime() > config.interactionTimeoutMinutes * 60_000) {
        await abortExecution(execution.userId, execution.id, true);
        continue;
      }
      await observeExecution(execution);
    } catch {
      // Temporary runtime errors are retried on the next loop. The lease stays held.
    }
  }
}

let loopRunning = false;
let kickPending = false;

async function runExecutionLoopOnce() {
  if (loopRunning) {
    kickPending = true;
    return;
  }
  loopRunning = true;
  try {
    await monitorActiveExecutions();
    let claimed: Execution | null;
    do {
      claimed = await claimNextExecution();
      if (claimed) await dispatchExecution(claimed);
    } while (claimed);
  } finally {
    loopRunning = false;
    if (kickPending) {
      kickPending = false;
      queueMicrotask(() => void runExecutionLoopOnce());
    }
  }
}

export function startExecutionLoop(log?: { warn: (value: unknown, message?: string) => void }) {
  let stopped = false;
  const run = () => {
    if (stopped) return;
    void runExecutionLoopOnce().catch((error) => log?.warn(error, "Execution loop failed"));
  };
  loopKick = run;
  run();
  const timer = setInterval(run, config.executionPollMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
    if (loopKick === run) loopKick = null;
  };
}

export function kickExecutionLoop() {
  loopKick?.();
}

async function currentRuntimeState(execution: Execution & { conversation: Conversation }) {
  if (!execution.conversation.nativeSessionId) {
    throw new ConversationServiceError("原生会话尚未建立", 409);
  }
  const connection = await connectExistingRuntime(execution.userId);
  return {
    connection,
    state: scopeExecutionState(await runtimeState(connection, execution.conversation.nativeSessionId), execution, execution.conversation.nativeSessionId),
  };
}

async function rejectPendingInteractions(
  connection: RuntimeConnection,
  state: RuntimeConversationState,
) {
  await Promise.all(state.questions.map((question) =>
    runtimeRequest(connection, "DELETE", `/api/session/${question.sessionID}/form/${question.id}`),
  ));
  await Promise.all(state.permissions.map(async (permission) => {
    const sessionId = permission.sessionID ?? permission.sessionId;
    if (!sessionId || !state.sessionIds.has(sessionId)) return;
    await runtimeRequest(
      connection,
      "POST",
      `/api/session/${sessionId}/permission/${permission.id}/reply`,
      { decision: "reject" },
    ).catch(() => undefined);
  }));
}

export async function abortExecution(userId: string, executionId: string, timedOut = false) {
  const execution = await requireOwnedExecution(userId, executionId);
  if (execution.status === ExecutionStatus.QUEUED) {
    const cancelled = await prisma.execution.update({
      where: { id: execution.id },
      data: {
        status: ExecutionStatus.CANCELLED,
        cancelRequestedAt: new Date(),
        finishedAt: new Date(),
      },
    });
    loopKick?.();
    return cancelled;
  }
  if (!activeStatuses.includes(execution.status)) return execution;
  if (!execution.conversation.nativeSessionId) {
    await markInterrupted(execution, "停止时原生会话标识缺失");
    return prisma.execution.findUniqueOrThrow({ where: { id: execution.id } });
  }
  await prisma.execution.update({
    where: { id: execution.id },
    data: { cancelRequestedAt: new Date() },
  });
  try {
    const connection = await connectExistingRuntime(userId);
    const beforeStop = scopeExecutionState(await runtimeState(connection, execution.conversation.nativeSessionId), execution, execution.conversation.nativeSessionId);
    await runtimeRequest(connection, "DELETE", `/api/session/${execution.conversation.nativeSessionId}/inbox/msg_opshelper_${execution.promptMarker.replaceAll("-", "")}`);
    for (const sessionID of [...beforeStop.sessionIds].reverse()) {
      await runtimeRequest(connection, "POST", `/api/session/${sessionID}/interrupt?resume=false`);
    }
    const pending = await runtimeState(connection, execution.conversation.nativeSessionId);
    await rejectPendingInteractions(connection, pending);
    let observed = await prisma.execution.findUniqueOrThrow({ where: { id: execution.id } });
    for (let attempt = 0; attempt < 20 && activeStatuses.includes(observed.status); attempt += 1) {
      await observeExecution(observed, connection);
      observed = await prisma.execution.findUniqueOrThrow({ where: { id: execution.id } });
      if (activeStatuses.includes(observed.status)) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    if (activeStatuses.includes(observed.status)) {
      throw new Error("停止请求已发送，但运行状态仍未结束");
    }
    if (timedOut && observed.status === ExecutionStatus.CANCELLED) {
      return prisma.execution.update({
        where: { id: observed.id },
        data: { status: ExecutionStatus.FAILED, error: "等待用户输入超时，任务已停止" },
      });
    }
    return observed;
  } catch (error) {
    const reason = `停止结果无法确认：${error instanceof Error ? error.message : "未知错误"}`;
    await markInterrupted(execution, reason);
    return prisma.execution.findUniqueOrThrow({ where: { id: execution.id } });
  }
}

export async function replyConversationQuestion(
  userId: string,
  executionId: string,
  requestId: string,
  answers: string[][],
) {
  const execution = await requireOwnedExecution(userId, executionId);
  if (execution.status !== ExecutionStatus.WAITING_INPUT) {
    throw new ConversationServiceError("该执行当前没有等待回答", 409);
  }
  const { connection, state } = await currentRuntimeState(execution);
  if (!state.questions.some((item) => item.id === requestId)) {
    throw new ConversationServiceError("问题已经失效", 409);
  }
  const form = state.questions.find((item) => item.id === requestId)!;
  await runtimeRequest(connection, "POST", `/api/session/${form.sessionID}/form/${requestId}/reply`, { answer: v2FormAnswer(form, answers) });
  await prisma.execution.update({
    where: { id: execution.id },
    data: { status: ExecutionStatus.RUNNING, waitingSince: null },
  });
  return getConversationSnapshot(userId, execution.conversationId);
}

export async function replyConversationPermission(
  userId: string,
  executionId: string,
  permissionId: string,
  response: "once" | "reject",
) {
  const execution = await requireOwnedExecution(userId, executionId);
  if (execution.status !== ExecutionStatus.WAITING_INPUT) {
    throw new ConversationServiceError("该执行当前没有等待确认", 409);
  }
  const { connection, state } = await currentRuntimeState(execution);
  const permission = state.permissions.find((item) => item.id === permissionId);
  const sessionId = permission?.sessionID ?? permission?.sessionId;
  if (!permission || !sessionId || !state.sessionIds.has(sessionId)) {
    throw new ConversationServiceError("确认请求已经失效", 409);
  }
  await runtimeRequest(
    connection,
    "POST",
    `/api/session/${sessionId}/permission/${permissionId}/reply`,
    { decision: response },
  );
  await prisma.execution.update({
    where: { id: execution.id },
    data: { status: ExecutionStatus.RUNNING, waitingSince: null },
  });
  return getConversationSnapshot(userId, execution.conversationId);
}

export async function reconcileInterruptedExecution(userId: string, executionId: string) {
  const execution = await requireOwnedExecution(userId, executionId);
  if (execution.status !== ExecutionStatus.INTERRUPTED) return execution;
  try {
    const connection = await connectRuntimeForRead(userId);
    let current = execution;
    if (!current.conversation.nativeSessionId) {
      const recoveredConversation = await ensureNativeSession(current.conversation, connection);
      current = await requireOwnedExecution(userId, executionId);
      current.conversation = recoveredConversation;
    }
    let state = scopeExecutionState(await runtimeState(connection, current.conversation.nativeSessionId!), execution, current.conversation.nativeSessionId!);
    if (current.cancelRequestedAt && (state.permissions.length > 0 || state.questions.length > 0)) {
      await rejectPendingInteractions(connection, state);
      state = scopeExecutionState(await runtimeState(connection, current.conversation.nativeSessionId!), execution, current.conversation.nativeSessionId!);
    }
    const markerSeen = state.rootMessages.some((message) => containsMarker(message, execution.promptMarker));
    const assistant = assistantAfterMarker(state.rootMessages, execution.promptMarker);
    const busy = Array.from(state.sessionIds).some((id) => state.statuses[id]?.type === "busy");
    const waiting = state.questions.length > 0 || state.permissions.length > 0;
    if (busy || waiting) {
      if (!markerSeen) return execution;
      await prisma.$transaction([
        prisma.execution.update({ where: { id: execution.id }, data: {
          status: waiting ? ExecutionStatus.WAITING_INPUT : ExecutionStatus.RUNNING,
          error: null, finishedAt: null, promptAcceptedAt: execution.promptAcceptedAt ?? new Date(),
          waitingSince: waiting ? execution.waitingSince ?? new Date() : null,
        } }),
        prisma.conversation.update({ where: { id: execution.conversationId }, data: { recoveryRequired: false, recoveryReason: null } }),
        prisma.containerInstance.update({ where: { userId }, data: {
          activeExecutionId: execution.id, executionLeaseOwner: randomUUID(),
          executionLeaseExpiresAt: new Date(Date.now() + leaseDurationMs),
          executionRecoveryRequired: false, executionRecoveryReason: null,
        } }),
      ]);
      loopKick?.();
      return prisma.execution.findUniqueOrThrow({ where: { id: execution.id } });
    }
    if (!markerSeen) {
      await prisma.$transaction([
        prisma.execution.update({
          where: { id: execution.id },
          data: {
            status: ExecutionStatus.FAILED,
            error: "恢复核对确认消息未送达，可以重新发送",
            finishedAt: new Date(),
          },
        }),
        prisma.conversation.update({
          where: { id: execution.conversationId },
          data: { recoveryRequired: false, recoveryReason: null },
        }),
        prisma.containerInstance.update({
          where: { userId },
          data: {
            executionRecoveryRequired: false,
            executionRecoveryReason: null,
            activeExecutionId: null,
            executionLeaseOwner: null,
            executionLeaseExpiresAt: null,
          },
        }),
      ]);
      loopKick?.();
      return prisma.execution.findUniqueOrThrow({ where: { id: execution.id } });
    }
    const complete = Boolean(assistant && isFinalAssistant(assistant));
    const hasError = currentExecutionMessages(state.rootMessages, executionPromptMarker(execution.promptMarker))
      .some((message) => Boolean(messageError(message)));
    const incomplete = !complete && !execution.cancelRequestedAt;
    const outputFiles = await finalizeOutputFiles(userId, execution.id);
    await prisma.$transaction([
      prisma.execution.update({
        where: { id: execution.id },
        data: {
          status: hasError || incomplete ? ExecutionStatus.FAILED : execution.cancelRequestedAt
            ? ExecutionStatus.CANCELLED
            : ExecutionStatus.SUCCEEDED,
          resultSummary: assistant ? summarizeMessage(assistant, maxResultLength) : null,
          error: hasError ? "恢复核对发现模型或工具错误" : incomplete ? "恢复核对确认执行已停止，但没有完整回答；未自动重发" : null,
          outputFiles: outputFiles as unknown as Prisma.InputJsonArray,
          finishedAt: new Date(),
        },
      }),
      prisma.conversation.update({
        where: { id: execution.conversationId },
        data: { recoveryRequired: false, recoveryReason: null },
      }),
      prisma.containerInstance.update({
        where: { userId },
        data: {
          executionRecoveryRequired: false,
          executionRecoveryReason: null,
          activeExecutionId: null,
          executionLeaseOwner: null,
          executionLeaseExpiresAt: null,
        },
      }),
    ]);
    loopKick?.();
  } catch {
    return execution;
  }
  return prisma.execution.findUniqueOrThrow({ where: { id: execution.id } });
}

export async function archiveConversation(userId: string, conversationId: string) {
  await requireOwnedConversation(userId, conversationId);
  const active = await prisma.execution.findFirst({
    where: { conversationId, status: { in: activeStatuses } },
  });
  if (active) throw new ConversationServiceError("当前对话仍有执行，结束后才能归档", 409);
  return prisma.conversation.update({
    where: { id: conversationId },
    data: { archivedAt: new Date() },
  });
}

export async function getConversationSnapshot(userId: string, conversationId: string): Promise<ConversationSnapshot> {
  const conversation = await requireOwnedConversation(userId, conversationId);
  const executions = await prisma.execution.findMany({
    where: { conversationId, userId },
    orderBy: { createdAt: "asc" },
  });
  const queued = await prisma.execution.findMany({
    where: { userId, status: ExecutionStatus.QUEUED },
    select: { id: true, userId: true, status: true },
    orderBy: { queueSequence: "asc" },
  });
  const positions = queuePositions(queued);
  let state: RuntimeConversationState | null = null;
  const active = findLastItem(executions, (execution) => activeStatuses.includes(execution.status));
  if (conversation.nativeSessionId) {
    try {
      const connection = await connectRuntimeForRead(userId);
      state = await runtimeState(connection, conversation.nativeSessionId);
      if (active) await observeExecution(active, connection);
    } catch {
      throw new ConversationServiceError("运行环境连接中断，正在重试", 503);
    }
  }
  const refreshedExecutions = active
    ? await prisma.execution.findMany({ where: { conversationId, userId }, orderBy: { createdAt: "asc" } })
    : executions;
  const refreshedConversation = active
    ? await prisma.conversation.findUniqueOrThrow({ where: { id: conversation.id } })
    : conversation;
  const refreshedActive = findLastItem(
    refreshedExecutions,
    (execution) => activeStatuses.includes(execution.status),
  );
  return {
    conversation: conversationSummary(
      { ...refreshedConversation, executions: refreshedExecutions.slice(-1) },
      positions,
    ),
    messages: sanitizeRuntimeMessages(state?.rootMessages ?? [], await visibleHistoryExecutions(userId, state?.rootMessages ?? [], refreshedExecutions)),
    executions: refreshedExecutions.map((execution) => serializeExecutionSummary(execution, positions.get(execution.id) ?? null)),
    collaborations: state ? collaborations(state) : [],
    pendingQuestion: refreshedActive && state ? pendingQuestion(scopeExecutionState(state, refreshedActive, conversation.nativeSessionId!)) : null,
    pendingPermissions: refreshedActive && state ? pendingPermissions(scopeExecutionState(state, refreshedActive, conversation.nativeSessionId!)) : [],
    refreshedAt: new Date().toISOString(),
  };
}

export function collaborationDetail(state: RuntimeConversationState, traceId: string): CollaborationSnapshot {
  const index = state.children.findIndex(({ session }) =>
    createHash("sha256").update(session.id).digest("hex").slice(0, 12) === traceId);
  if (index < 0) throw new ConversationServiceError("子智能体会话不存在", 404);
  const child = state.children[index];
  const belongs = (request: RuntimeRequest) =>
    (request.sessionID ?? request.sessionId) === child.session.id;
  const scoped = { ...state, questions: state.questions.filter(belongs), permissions: state.permissions.filter(belongs) };
  return {
    collaboration: collaborations(state)[index],
    messages: sanitizeRuntimeMessages(child.messages),
    executionId: null,
    autoApprovePermissions: false,
    pendingQuestion: pendingQuestion(scoped),
    pendingPermissions: pendingPermissions(scoped),
  };
}

export async function getCollaborationSnapshot(userId: string, conversationId: string, traceId: string): Promise<CollaborationSnapshot> {
  const conversation = await requireOwnedConversation(userId, conversationId);
  if (!conversation.nativeSessionId) throw new ConversationServiceError("子智能体会话不存在", 404);
  const connection = await connectRuntimeForRead(userId);
  const state = await runtimeState(connection, conversation.nativeSessionId);
  const detail = collaborationDetail(state, traceId);
  const active = await prisma.execution.findFirst({
    where: { conversationId, userId, status: { in: activeStatuses } },
    orderBy: { createdAt: "desc" },
  });
  if (active) {
    const scoped = scopeExecutionState(state, active, conversation.nativeSessionId);
    if (scoped.children.some(({ session }) =>
      createHash("sha256").update(session.id).digest("hex").slice(0, 12) === traceId)) {
      detail.executionId = active.id;
      detail.autoApprovePermissions = active.autoApprovePermissions;
    }
  }
  if (!detail.executionId) {
    detail.pendingQuestion = null;
    detail.pendingPermissions = [];
  }
  return detail;
}

export async function openConversationEvents(userId: string, conversationId: string, signal: AbortSignal) {
  const conversation = await requireOwnedConversation(userId, conversationId);
  if (!conversation.nativeSessionId) throw new ConversationServiceError("会话尚未就绪", 409);
  // Merely viewing a stream must not start or rebuild a user's container.
  const connection = await connectExistingRuntime(userId);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) controller.abort();
  const deadline = setTimeout(abort, 15_000);
  const connectedAt = Date.now();
  try {
    const response = await fetch(`${connection.target}/api/event`, {
      headers: { authorization: connection.authorization, accept: "text/event-stream" },
      signal: controller.signal,
    });
    if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
      throw new ConversationServiceError("实时连接暂不可用", 503);
    }
    const readExecutionIds = () => prisma.execution.findMany({
      where: { userId, conversationId },
      select: { id: true },
    }).then((items) => items.map((item) => item.id));
    // Subscribe first. OpenCode persists the full text only at text-end; the
    // stream preserves the deltas generated while the initial snapshot loads.
    const [messages, executionIds] = await Promise.all([
      runtimeRequest<unknown[]>(connection, "GET", `/api/session/${conversation.nativeSessionId}/message`),
      readExecutionIds(),
    ]);
    const inherited = await visibleHistoryExecutions(userId, messages, []);
    clearTimeout(deadline);
    const historicalIds = inherited.map((execution) => execution.id);
    const projector = new ConversationTextProjector(conversation.nativeSessionId, [...executionIds, ...historicalIds], connectedAt);
    const initial = projector.seed(messages);
    const body = response.body;
    return (async function* () {
      try {
        for (const text of initial) yield conversationEventFrame("text", text);
        yield conversationEventFrame("ready");
        let lastChanged = 0;
        for await (const rawEvent of readRuntimeEvents(body)) {
          const event = normalizeV2Event(rawEvent);
          if (signal.aborted) break;
          if (event.type === "server.heartbeat" || event.type === "server.connected") {
            yield ": keepalive\n\n";
            continue;
          }
          if (!projector.accepts(event)) continue;
          const info = event.properties?.info;
          if (event.type === "message.updated" && info?.role === "assistant" && !projector.hasMessage(info.id)) {
            projector.setExecutionIds([...await readExecutionIds(), ...historicalIds]);
          }
          for (const text of projector.apply(event)) yield conversationEventFrame("text", text);
          if (event.type !== "message.part.delta" && Date.now() - lastChanged >= 200) {
            lastChanged = Date.now();
            yield conversationEventFrame("changed");
          }
        }
      } finally {
        controller.abort();
        signal.removeEventListener("abort", abort);
      }
    })();
  } catch (error) {
    clearTimeout(deadline);
    controller.abort();
    signal.removeEventListener("abort", abort);
    throw error;
  }
}

export function resetExecutionLoopForTests() {
  loopKick = null;
  loopRunning = false;
  kickPending = false;
}
