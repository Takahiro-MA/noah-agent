export type BridgeSession = {
  sessionId: string;
  claudeSessionId: string;
  callerSessionKey: string;
  createdAt: number;
  lastActivityAt: number;
  status: "active" | "idle" | "expired";
  messageCount: number;
};

export type BridgeTaskParams = {
  message: string;
  sessionId?: string;
  model?: string;
  systemPrompt?: string;
  timeoutMs?: number;
  streaming?: boolean;
};

export type BridgeTaskResult = {
  text: string;
  claudeSessionId?: string;
  durationMs: number;
};

export type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_use"; name: string; input: string }
  | { type: "result"; text: string; durationMs: number; sessionId?: string }
  | { type: "error"; message: string };

export type BridgeTaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export type BridgeTask = {
  taskId: string;
  sessionId: string;
  status: BridgeTaskStatus;
  params: BridgeTaskParams;
  result?: BridgeTaskResult;
  error?: string;
  startedAt: number;
};

export type NoahConfig = {
  port: number;
  model: string;
  timeoutMs: number;
  watchdogMs: number;
  claudeCommand: string;
  workspaceDir: string;
  stateDir: string;
  schedulesDir: string;
  sessionIdleMs: number;
  sessionExpireMs: number;
};

export const DEFAULTS: NoahConfig = {
  port: 18790,
  model: "opus",
  timeoutMs: 300_000,
  watchdogMs: 120_000,
  claudeCommand: "claude",
  workspaceDir: process.cwd(),
  stateDir: `${process.env.HOME}/.noah-agent/state`,
  schedulesDir: `${process.env.HOME}/noah-agent/config/schedules`,
  sessionIdleMs: 30 * 60 * 1000,
  sessionExpireMs: 24 * 60 * 60 * 1000,
};
