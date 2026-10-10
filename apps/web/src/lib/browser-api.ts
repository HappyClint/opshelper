import type {
  CollaborationSnapshot,
  AdminAgentsSnapshot,
  AgentDetail,
  AgentDirectoryRequest,
  AdminUsersSnapshot,
  ContainerActionResponse,
  CreateUserRequest,
  CreateUserResponse,
  LoginRequest,
  LoginResponse,
  UpdateUserRequest,
  UserResponse,
  UserAgentAssignmentsSnapshot,
  ConversationsResponse,
  ConversationSnapshot,
  CreateConversationRequest,
  ForkConversationResponse,
  CreateExecutionRequest,
  ScheduleDetailResponse,
  ScheduleInput,
  ScheduleRunAnswerResponse,
  SchedulesResponse,
  SkillPackageImport,
} from "@opshelper/shared";

async function parseResponse<T>(response: Response) {
  if (response.status === 204) {
    return null as T;
  }

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const message =
      (payload as { message?: string } | null)?.message ??
      "Request failed";
    throw new Error(message);
  }

  return payload as T;
}

async function fetchJson<T>(path: string, init?: RequestInit) {
  const response = await fetch(path, init);
  return parseResponse<T>(response);
}

export async function login(input: LoginRequest) {
  return fetchJson<LoginResponse>("/v1/auth/login", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
}

export async function logout() {
  const response = await fetch("/v1/auth/logout", {
    method: "POST",
  });

  return parseResponse<void>(response);
}

export async function createUser(input: CreateUserRequest) {
  return fetchJson<CreateUserResponse>("/v1/admin/users", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
}

export async function updateUser(userId: string, input: UpdateUserRequest) {
  return fetchJson<UserResponse>(`/v1/admin/users/${userId}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
}

export async function deleteUser(userId: string) {
  return fetchJson<void>(`/v1/admin/users/${userId}`, {
    method: "DELETE",
  });
}

export async function listUsers(query = "") {
  const search = query.trim()
    ? `?q=${encodeURIComponent(query.trim())}`
    : "";

  return fetchJson<AdminUsersSnapshot>(`/v1/admin/users${search}`, {
    cache: "no-store",
  });
}

export async function listAgents() {
  return fetchJson<AdminAgentsSnapshot>("/v1/admin/agents", {
    cache: "no-store",
  });
}

export async function getAgent(key: string) {
  return fetchJson<{ agent: AgentDetail }>(
    `/v1/admin/agents/${encodeURIComponent(key)}`,
    { cache: "no-store" },
  );
}

export async function importAgentSkillPackage(file: File) {
  const body = new FormData();
  body.append("file", file);
  return fetchJson<SkillPackageImport>("/v1/admin/agents/skill-package", {
    method: "POST",
    body,
  });
}

export async function createAgent(input: AgentDirectoryRequest) {
  return fetchJson<{ agent: AgentDetail }>("/v1/admin/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function updateAgent(
  key: string,
  input: Pick<AgentDirectoryRequest, "files" | "binaryFiles">,
) {
  return fetchJson<{ agent: AgentDetail }>(
    `/v1/admin/agents/${encodeURIComponent(key)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
}

export async function deleteAgent(key: string) {
  return fetchJson<void>(`/v1/admin/agents/${encodeURIComponent(key)}`, {
    method: "DELETE",
  });
}

export async function setAgentEnabled(key: string, isEnabled: boolean) {
  return fetchJson<{ agent: AgentDetail }>(
    `/v1/admin/agents/${encodeURIComponent(key)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isEnabled }),
    },
  );
}

export async function checkAgent(key: string) {
  return fetchJson<{ agent: AgentDetail }>(
    `/v1/admin/agents/${encodeURIComponent(key)}/check`,
    { method: "POST" },
  );
}

export async function getUserAgentAssignments(userId: string) {
  return fetchJson<UserAgentAssignmentsSnapshot>(
    `/v1/admin/users/${encodeURIComponent(userId)}/agents`,
    { cache: "no-store" },
  );
}

export async function replaceUserAgentAssignments(
  userId: string,
  agentIds: string[],
  expectedDesiredGeneration: number,
) {
  return fetchJson<UserAgentAssignmentsSnapshot>(
    `/v1/admin/users/${encodeURIComponent(userId)}/agents`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentIds, expectedDesiredGeneration }),
    },
  );
}

export async function reconcileUserAgentAssignments(userId: string) {
  return fetchJson<UserAgentAssignmentsSnapshot>(
    `/v1/admin/users/${encodeURIComponent(userId)}/agents/reconcile`,
    { method: "POST" },
  );
}

export async function mutateContainer(path: string, method = "POST") {
  const response = await fetch(path, {
    method,
  });

  return parseResponse<ContainerActionResponse>(response);
}

export async function changePassword(currentPassword: string, newPassword: string) {
  return fetchJson<void>("/v1/auth/change-password", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}

export async function listConversations() {
  return fetchJson<ConversationsResponse>("/v1/conversations", { cache: "no-store" });
}

export async function createConversation(input: CreateConversationRequest) {
  return fetchJson<{ conversationId: string }>("/v1/conversations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function getConversation(conversationId: string) {
  return fetchJson<ConversationSnapshot>(
    `/v1/conversations/${encodeURIComponent(conversationId)}`,
    { cache: "no-store" },
  );
}

export async function forkConversation(conversationId: string, messageId: string) {
  return fetchJson<ForkConversationResponse>(
    `/v1/conversations/${encodeURIComponent(conversationId)}/fork`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId }),
    },
  );
}

export async function archiveConversation(conversationId: string) {
  return fetchJson<void>(`/v1/conversations/${encodeURIComponent(conversationId)}`, {
    method: "DELETE",
  });
}

export async function createExecution(
  conversationId: string,
  input: CreateExecutionRequest,
) {
  return fetchJson<{ executionId: string }>(
    `/v1/conversations/${encodeURIComponent(conversationId)}/executions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
}

export async function abortExecution(executionId: string) {
  return fetchJson<{ status: string }>(
    `/v1/executions/${encodeURIComponent(executionId)}/abort`,
    { method: "POST" },
  );
}

export async function reconcileExecution(executionId: string) {
  return fetchJson<{ status: string; error: string | null }>(
    `/v1/executions/${encodeURIComponent(executionId)}/reconcile`,
    { method: "POST" },
  );
}

export async function replyExecutionQuestion(
  executionId: string,
  requestId: string,
  answers: string[][],
) {
  return fetchJson<ConversationSnapshot>(
    `/v1/executions/${encodeURIComponent(executionId)}/questions/${encodeURIComponent(requestId)}/reply`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers }),
    },
  );
}

export async function replyExecutionPermission(
  executionId: string,
  requestId: string,
  response: "once" | "reject",
) {
  return fetchJson<ConversationSnapshot>(
    `/v1/executions/${encodeURIComponent(executionId)}/permissions/${encodeURIComponent(requestId)}/reply`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response }),
    },
  );
}

export async function listSchedules() {
  return fetchJson<SchedulesResponse>("/v1/me/schedules", { cache: "no-store" });
}

export async function getSchedule(scheduleId: string) {
  return fetchJson<ScheduleDetailResponse>(
    `/v1/me/schedules/${encodeURIComponent(scheduleId)}`,
    { cache: "no-store" },
  );
}

export async function getScheduleRunAnswer(scheduleId: string, runId: string) {
  return fetchJson<ScheduleRunAnswerResponse>(
    `/v1/me/schedules/${encodeURIComponent(scheduleId)}/runs/${encodeURIComponent(runId)}/answer`,
    { cache: "no-store" },
  );
}

export async function createSchedule(input: ScheduleInput) {
  return fetchJson<ScheduleDetailResponse>("/v1/me/schedules", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export async function updateSchedule(scheduleId: string, input: ScheduleInput) {
  return fetchJson<ScheduleDetailResponse>(
    `/v1/me/schedules/${encodeURIComponent(scheduleId)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
}

export async function deleteSchedule(scheduleId: string) {
  return fetchJson<void>(
    `/v1/me/schedules/${encodeURIComponent(scheduleId)}`,
    { method: "DELETE" },
  );
}

export async function pauseSchedule(scheduleId: string) {
  return fetchJson<ScheduleDetailResponse>(
    `/v1/me/schedules/${encodeURIComponent(scheduleId)}/pause`,
    { method: "POST" },
  );
}

export async function resumeSchedule(scheduleId: string) {
  return fetchJson<ScheduleDetailResponse>(
    `/v1/me/schedules/${encodeURIComponent(scheduleId)}/resume`,
    { method: "POST" },
  );
}

export async function runSchedule(scheduleId: string, requestKey: string) {
  return fetchJson<{ runId: string; executionId: string; conversationId: string }>(
    `/v1/me/schedules/${encodeURIComponent(scheduleId)}/runs`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestKey }),
    },
  );
}

export async function getCollaboration(conversationId: string, traceId: string) {
  return fetchJson<CollaborationSnapshot>(
    `/v1/conversations/${encodeURIComponent(conversationId)}/collaborations/${encodeURIComponent(traceId)}`,
    { cache: "no-store" },
  );
}
