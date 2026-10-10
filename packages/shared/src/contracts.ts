export type UserRole = "user" | "admin";
export type ContainerStatus =
  | "creating"
  | "running"
  | "stopped"
  | "deleting"
  | "error";

export interface UserSummary {
  id: string;
  username: string;
  name: string;
  role: UserRole;
  isActive?: boolean;
  keepContainerAlive?: boolean;
  createdAt: string;
}

export interface AuthenticatedUser {
  id: string;
  username: string;
  name: string;
  role: UserRole;
}

export interface ContainerSummary {
  id: string;
  ownerId: string;
  ownerName: string;
  name: string;
  image: string;
  status: ContainerStatus;
  lastActivityAt: string | null;
  lastStartedAt?: string | null;
  lastStoppedAt?: string | null;
}

export interface ActivityItem {
  id: string;
  containerId: string | null;
  kind: "proxy" | "start" | "stop" | "delete";
  detail: string;
  occurredAt: string;
}

export interface SessionResponse {
  authenticated: boolean;
  user: AuthenticatedUser | null;
}

export interface ProgrammaticSession {
  token: string;
  tokenType: "Bearer";
  expiresAt: string;
  cookieName: string;
}

export interface UserPortalSnapshot {
  user: AuthenticatedUser;
  container: (ContainerSummary & {
    lastActivityAtLabel: string;
    lastStartedAtLabel: string;
    lastStoppedAtLabel: string;
  }) | null;
  recentActivity: Array<
    ActivityItem & {
      occurredAtLabel: string;
      kindLabel: string;
    }
  >;
}

export interface AdminSnapshot {
  metrics: {
    totalUsers: number;
    runningContainers: number;
    idleCandidates: number;
  };
  users: Array<
    UserSummary & {
      createdAtLabel: string;
    }
  >;
  containers: Array<
    ContainerSummary & {
      lastActivityAtLabel: string;
    }
  >;
  nextSteps: string[];
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  user: AuthenticatedUser;
  session: ProgrammaticSession;
}

export interface CreateUserRequest {
  username: string;
  password: string;
  name?: string;
  role?: UserRole;
  isActive?: boolean;
  keepContainerAlive?: boolean;
}

export interface CreateUserResponse {
  user: UserSummary;
}

export interface UpdateUserRequest {
  username?: string;
  password?: string;
  name?: string;
  role?: UserRole;
  isActive?: boolean;
  keepContainerAlive?: boolean;
}

export interface UserResponse {
  user: UserSummary;
}

export interface AdminUsersSnapshot {
  query: string;
  total: number;
  users: Array<
    UserSummary & {
      createdAtLabel: string;
    }
  >;
}

export interface ContainerActionResponse {
  container: (ContainerSummary & {
    lastActivityAtLabel: string;
    lastStartedAtLabel: string;
    lastStoppedAtLabel: string;
  }) | null;
}


export interface ChatModelOption {
  id: string;
  name: string;
  /** 发给 opencode 的完整模型引用，形如 "custom/<id>"。 */
  model: string;
}

export interface ChatModelsResponse {
  models: ChatModelOption[];
  /** 完整引用（"custom/<id>"）；"" 表示管理员尚未配置模型组。 */
  defaultModel: string;
}

export type AgentCheckStatus = "pending" | "ready" | "error";
export type AgentMode = "primary" | "subagent" | "all";
export type AgentConfigStatus =
  | "draining"
  | "revoking"
  | "applying"
  | "ready"
  | "frozen";

export interface AgentSummary {
  id: string;
  key: string;
  displayName: string;
  description: string;
  mode: AgentMode;
  isEnabled: boolean;
  contentHash: string | null;
  checkStatus: AgentCheckStatus;
  checkError: string | null;
  checkedAt: string | null;
  assignmentCount: number;
}

export interface AgentDetail extends AgentSummary {
  files: Record<string, string>;
  /** Base64-encoded supporting files that cannot be edited as UTF-8 text. */
  binaryFiles: Record<string, string>;
}

export interface AdminAgentsSnapshot {
  agents: AgentSummary[];
}

export interface AgentConfigurationState {
  status: AgentConfigStatus;
  desiredGeneration: number;
  appliedGeneration: number;
  expectedAgentKeys: string[];
  actualAgentKeys: string[];
  desiredRuntimeHash: string | null;
  appliedRuntimeHash: string | null;
  error: string | null;
  action: "none" | "wait" | "retry";
}

export interface UserAgentAssignmentsSnapshot {
  user: UserSummary;
  assignedAgentIds: string[];
  agents: AgentSummary[];
  configuration: AgentConfigurationState;
}

export interface AgentDirectoryRequest {
  key: string;
  files: Record<string, string>;
  /** Base64-encoded binary assets imported with a Skill package. */
  binaryFiles?: Record<string, string>;
}

export interface SkillPackageImport {
  skillName: string;
  files: Record<string, string>;
  binaryFiles: Record<string, string>;
}

export type ExecutionStatus =
  | "queued"
  | "dispatching"
  | "running"
  | "waiting_input"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export type ExecutionSource = "chat" | "scheduled" | "schedule_manual";

export interface ConversationAgent {
  key: string;
  name: string;
  description: string;
  mode: AgentMode;
}

export interface ConversationSummary {
  id: string;
  title: string;
  leadAgentKey: string;
  recoveryRequired: boolean;
  recoveryReason: string | null;
  latestExecutionStatus: ExecutionStatus | null;
  queuePosition: number | null;
  source: ExecutionSource | null;
  scheduleName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionSummary {
  id: string;
  status: ExecutionStatus;
  leadAgentKey: string;
  agentKeys: string[];
  actualAgentKeys: string[];
  configGeneration: number;
  inputText: string;
  attachments: ConversationAttachment[];
  outputFiles: ConversationAttachment[];
  queuePosition: number | null;
  resultSummary: string | null;
  error: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  source: ExecutionSource;
  scheduleRunId: string | null;
  autoApprovePermissions: boolean;
}

export interface ConversationAttachment {
  path: string;
  filename: string;
  mime: string;
}

export interface ConversationCollaboration {
  traceId: string;
  agentKey: string;
  title: string;
  status: "running" | "waiting_input" | "completed" | "failed";
  summary: string | null;
}

export interface ConversationQuestion {
  id: string;
  questions: Array<{
    header?: string;
    question: string;
    options: Array<{ label: string; description?: string }>;
    multiple?: boolean;
    custom?: boolean;
  }>;
}

export interface ConversationPermission {
  id: string;
  title: string;
  tool?: string;
  detail?: string;
}

export interface ConversationSnapshot {
  conversation: ConversationSummary;
  messages: unknown[];
  executions: ExecutionSummary[];
  collaborations: ConversationCollaboration[];
  pendingQuestion: ConversationQuestion | null;
  pendingPermissions: ConversationPermission[];
  refreshedAt: string;
}

export interface ConversationsResponse {
  agents: ConversationAgent[];
  conversations: ConversationSummary[];
  executionBlockedReason: string | null;
}

export interface CreateConversationRequest {
  leadAgentKey: string;
  title?: string;
}

export interface ForkConversationResponse {
  conversationId: string;
  leadAgentKey: string;
  text: string;
  attachments: ConversationAttachment[];
}

export interface CreateExecutionRequest {
  requestKey: string;
  leadAgentKey: string;
  text: string;
  attachments?: ConversationAttachment[];
  model?: string;
  autoApprovePermissions?: boolean;
}

export type ScheduleStatus = "active" | "paused" | "completed";
export type ScheduleFrequency = "once" | "daily" | "weekly" | "cron";

export interface ScheduleInput {
  name: string;
  prompt: string;
  leadAgentKey: string;
  participantAgentKeys: string[];
  attachments: ConversationAttachment[];
  model?: string;
  autoApprovePermissions: boolean;
  rule: import("./schedule-time").ScheduleRule;
}

export interface ScheduleRunSummary {
  id: string;
  trigger: "scheduled" | "manual";
  decision: "enqueued" | "skipped";
  scheduledFor: string;
  skipReason: string | null;
  missedThrough: string | null;
  missedCount: number;
  execution: ExecutionSummary | null;
  conversationId: string | null;
  plannedAgentKeys: string[];
}

export interface ScheduleSummary {
  id: string;
  name: string;
  prompt: string;
  leadAgentKey: string;
  participantAgentKeys: string[];
  attachments: ConversationAttachment[];
  model: string | null;
  autoApprovePermissions: boolean;
  frequency: ScheduleFrequency;
  localDate: string | null;
  localTime: string;
  weekday: number | null;
  cronExpression: string | null;
  timeZone: "Asia/Shanghai";
  status: ScheduleStatus;
  statusReason: string | null;
  nextRunAt: string | null;
  lastRun: ScheduleRunSummary | null;
  canResume: boolean;
  canRunNow: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SchedulesResponse {
  agents: ConversationAgent[];
  schedules: ScheduleSummary[];
}

export interface ScheduleDetailResponse {
  schedule: ScheduleSummary;
  runs: ScheduleRunSummary[];
}

/** 结果弹窗展示的模型回答；运行环境不可读取时为 null，页面沿用已保存的结果。 */
export interface ScheduleRunAnswerResponse {
  runId: string;
  answer: string | null;
}

export interface CollaborationSnapshot {
  collaboration: ConversationCollaboration;
  messages: unknown[];
  executionId: string | null;
  autoApprovePermissions: boolean;
  pendingQuestion: ConversationQuestion | null;
  pendingPermissions: ConversationPermission[];
}
