/**
 * Defensive shapes used only to parse sanitized OpenCode data returned through
 * the formal Conversation API. The browser has no direct runtime client.
 */
export interface OpencodeSession {
  id: string;
  title?: string;
  parentID?: string;
  [key: string]: unknown;
}

export interface OpencodeAgentConfig {
  description?: string;
  [key: string]: unknown;
}

export interface OpencodeConfig {
  agent?: Record<string, OpencodeAgentConfig>;
  [key: string]: unknown;
}

export interface OpencodeAgentInfo {
  name: string;
  description?: string;
  mode?: "primary" | "subagent" | "all";
  native?: boolean;
  hidden?: boolean;
  [key: string]: unknown;
}

export interface OpencodeQuestionOption {
  label: string;
  description?: string;
}

export interface OpencodeQuestionItem {
  header?: string;
  question: string;
  options: OpencodeQuestionOption[];
  multiple?: boolean;
  custom?: boolean;
}

export interface OpencodeQuestionRequest {
  id: string;
  sessionID?: string;
  sessionId?: string;
  questions: OpencodeQuestionItem[];
}

export interface OpencodePermission {
  id: string;
  sessionID?: string;
  sessionId?: string;
  permission?: string;
  metadata?: Record<string, unknown>;
  patterns?: string[];
  [key: string]: unknown;
}
