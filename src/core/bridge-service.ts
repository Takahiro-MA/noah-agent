import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { SessionStore } from "./session-store.js";
import { runClaudeBridge, runClaudeBridgeStream } from "./claude-runner.js";
import type { NoahConfig, BridgeTask, BridgeTaskParams, BridgeTaskResult, StreamEvent } from "./types.js";

export class BridgeService {
  private readonly sessions: SessionStore;
  private readonly tasks = new Map<string, BridgeTask>();
  private readonly config: NoahConfig;
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(config: NoahConfig) {
    this.config = config;
    this.sessions = new SessionStore(config.stateDir);

    // Periodic session cleanup every 10 minutes
    this.cleanupTimer = setInterval(() => {
      this.sessions.cleanup(config.sessionIdleMs, config.sessionExpireMs);
    }, 10 * 60 * 1000);
  }

  private prepareTask(params: BridgeTaskParams): {
    task: BridgeTask;
    sessionId: string;
    claudeSessionId: string;
    isResume: boolean;
  } {
    let session = params.sessionId ? this.sessions.get(params.sessionId) : null;
    const isResume = session !== null;
    if (!session) {
      session = this.sessions.create();
    }

    const taskId = `task-${crypto.randomUUID().slice(0, 12)}`;
    const task: BridgeTask = {
      taskId,
      sessionId: session.sessionId,
      status: "running",
      params,
      startedAt: Date.now(),
    };
    this.tasks.set(taskId, task);

    return {
      task,
      sessionId: session.sessionId,
      claudeSessionId: session.claudeSessionId,
      isResume,
    };
  }

  private buildRunnerParams(
    params: BridgeTaskParams,
    claudeSessionId: string,
    isResume: boolean,
  ) {
    return {
      prompt: params.message,
      claudeSessionId,
      isResume,
      model: params.model ?? this.config.model,
      systemPrompt: params.systemPrompt,
      workspaceDir: this.config.workspaceDir,
      claudeCommand: this.config.claudeCommand,
      timeoutMs: params.timeoutMs ?? this.config.timeoutMs,
      watchdogMs: this.config.watchdogMs,
    };
  }

  async submitTask(params: BridgeTaskParams): Promise<BridgeTask> {
    const { task, sessionId, claudeSessionId, isResume } = this.prepareTask(params);

    try {
      const result = await runClaudeBridge(
        this.buildRunnerParams(params, claudeSessionId, isResume),
      );

      if (result.claudeSessionId) {
        this.sessions.updateClaudeSessionId(sessionId, result.claudeSessionId);
      }
      this.sessions.touch(sessionId);

      task.status = "completed";
      task.result = result;
      return task;
    } catch (err) {
      task.status = "failed";
      task.error = err instanceof Error ? err.message : String(err);
      return task;
    }
  }

  submitTaskStream(params: BridgeTaskParams): {
    taskId: string;
    sessionId: string;
    events: EventEmitter;
    cancel: () => void;
  } {
    const { task, sessionId, claudeSessionId, isResume } = this.prepareTask(params);

    const handle = runClaudeBridgeStream(
      this.buildRunnerParams(params, claudeSessionId, isResume),
    );

    handle.events.on("done", (result: BridgeTaskResult) => {
      if (result.claudeSessionId) {
        this.sessions.updateClaudeSessionId(sessionId, result.claudeSessionId);
      }
      this.sessions.touch(sessionId);
      task.status = "completed";
      task.result = result;
    });

    handle.events.on("error", (err: Error) => {
      task.status = "failed";
      task.error = err.message;
    });

    return {
      taskId: task.taskId,
      sessionId: task.sessionId,
      events: handle.events,
      cancel: handle.cancel,
    };
  }

  getTask(taskId: string): BridgeTask | null {
    return this.tasks.get(taskId) ?? null;
  }

  cancelTask(taskId: string): boolean {
    const task = this.tasks.get(taskId);
    if (task && (task.status === "pending" || task.status === "running")) {
      task.status = "cancelled";
      return true;
    }
    return false;
  }

  listSessions() {
    return this.sessions.list();
  }

  deleteSession(sessionId: string): boolean {
    return this.sessions.delete(sessionId);
  }

  shutdown(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }
}
