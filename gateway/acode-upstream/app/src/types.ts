export type SessionStatus = "starting" | "running" | "waiting-approval" | "completed" | "failed" | "cancelled" | string;

export interface Device {
  deviceId: string;
  deviceName?: string;
  connected: boolean;
}

export interface ModelOption {
  id: string;
  name?: string;
  model?: string;
  supportedReasoningEfforts?: string[];
}

export interface Session {
  id: string;
  title?: string;
  workspacePath?: string;
  cwd?: string;
  project?: string;
  projectName?: string;
  status?: SessionStatus;
  sessionPolicyMode?: "confirm" | "full-access";
  canResume?: boolean;
  resumeStatus?: "resumable" | "history-only" | "missing-thread";
  modelLabel?: string;
  modelProvider?: string;
  createdAt?: string;
  updatedAt?: string;
  lastUpdatedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  lastTurnStartedAt?: string;
  lastTurnFinishedAt?: string;
  parentSessionId?: string;
  childSessionIds?: string[];
  threadSource?: string;
  agentNickname?: string;
  agentRole?: string;
  activeTurnId?: string;
}

export interface Attachment {
  name: string;
  mimeType?: string;
  size?: number;
  dataBase64: string;
}

export interface ApprovalRequest {
  requestId: string;
  sessionId: string;
  requestMethod: string;
  turnId?: string;
  itemId?: string;
  summary?: string;
  command?: string;
  cwd?: string;
  expiresAt?: string;
  proposedExecpolicyAmendment?: string[];
  status: "pending" | "approved" | "denied" | "expired";
  decision?: "approve" | "deny";
  autoApproved?: boolean;
  createdAt?: string;
  resolvedAt?: string;
  rawParams?: any;
}

export interface ToolCommandExecution {
  type: "commandExecution";
  id: string;
  command: string;
  cwd?: string;
  aggregatedOutput?: string;
  exitCode?: number;
  status: "running" | "completed" | "failed";
  durationMs?: number;
}

export interface ToolFileChange {
  type: "fileChange";
  id: string;
  path: string;
  kind: "add" | "modify" | "delete" | string;
  diff?: string;
  status?: string;
}

export interface SubAgentActivity {
  type: "subAgentActivity";
  agentThreadId: string;
  agentPath?: string;
  kind: "started" | "completed" | "stopped" | "failed" | string;
  status?: string;
  toolCall?: any;
}

export type ToolItem = ToolCommandExecution | ToolFileChange | SubAgentActivity;

export interface TurnMessage {
  turnId: string;
  sessionId: string;
  clientRequestId?: string;
  userPrompt?: string;
  userAttachments?: Attachment[];
  userTime?: string;
  isInterjection?: boolean;
  assistantStatus: "idle" | "streaming" | "waiting-approval" | "completed" | "cancelled" | "failed";
  reasoning: string;
  reasoningSummary?: string[];
  reasoningCompleted?: boolean;
  text: string;
  tools: ToolItem[];
  diffs: string[];
  tokenUsage?: {
    totalTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    reasoningOutputTokens?: number;
  };
  approvals: ApprovalRequest[];
  startedAt?: string;
  completedAt?: string;
}

export interface EventMessage {
  type: string;
  sessionId?: string;
  requestId?: string;
  payload?: any;
  eventSeq?: number;
  timestamp?: string;
  method?: string;
  params?: any;
}

export interface ConfigEndpoints {
  api: string;
  ws: string;
}
