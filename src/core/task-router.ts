import { EventEmitter } from "node:events";
import type { BridgeService } from "./bridge-service.js";
import { runCodex, type CodexResult } from "../runners/codex-runner.js";
import { runScript, type ScriptResult } from "../runners/script-runner.js";
import type { BridgeTask, BridgeTaskResult, StreamEvent } from "./types.js";

// ── Types ──────────────────────────────────────────────────────────────

export type RunnerType = "claude" | "codex" | "script" | "multi";

export type RoutedTaskParams = {
  message: string;
  runner?: RunnerType;
  sessionId?: string;
  model?: string;
  systemPrompt?: string;
  timeoutMs?: number;
  streaming?: boolean;
  /** For script runner */
  command?: string;
  args?: string[];
  cwd?: string;
  /** For multi-agent: sub-tasks to run in parallel */
  subtasks?: Array<{
    runner: RunnerType;
    message: string;
    model?: string;
    systemPrompt?: string;
  }>;
};

export type RoutedTaskResult = {
  runner: RunnerType;
  text: string;
  durationMs: number;
  subtaskResults?: Array<{
    runner: RunnerType;
    text: string;
    durationMs: number;
    error?: string;
  }>;
};

// ── Router ─────────────────────────────────────────────────────────────

export class TaskRouter {
  private readonly bridgeService: BridgeService;
  private readonly codexApiKey: string | undefined;

  constructor(bridgeService: BridgeService, codexApiKey?: string) {
    this.bridgeService = bridgeService;
    this.codexApiKey = codexApiKey;
  }

  /**
   * Route a task to the appropriate runner.
   * If runner is not specified, auto-detect based on heuristics.
   */
  async route(params: RoutedTaskParams): Promise<RoutedTaskResult> {
    const runner = params.runner ?? this.detectRunner(params);

    switch (runner) {
      case "claude":
        return this.runClaude(params);
      case "codex":
        return this.runCodexTask(params);
      case "script":
        return this.runScriptTask(params);
      case "multi":
        return this.runMulti(params);
      default:
        return this.runClaude(params);
    }
  }

  /**
   * Route with streaming (only supported for Claude runner).
   * Falls back to non-streaming for other runners.
   */
  routeStream(params: RoutedTaskParams): {
    runner: RunnerType;
    events: EventEmitter;
    cancel: () => void;
  } {
    const runner = params.runner ?? this.detectRunner(params);

    if (runner === "claude") {
      const { events, cancel } = this.bridgeService.submitTaskStream({
        message: params.message,
        sessionId: params.sessionId,
        model: params.model,
        systemPrompt: params.systemPrompt,
        timeoutMs: params.timeoutMs,
        streaming: true,
      });
      return { runner, events, cancel };
    }

    // Non-streaming runners: emit events after completion
    const emitter = new EventEmitter();
    let cancelled = false;

    const run = async () => {
      try {
        const result = await this.route({ ...params, runner });
        if (cancelled) return;
        emitter.emit("event", {
          type: "text_delta",
          text: result.text,
        } satisfies StreamEvent);
        emitter.emit("event", {
          type: "result",
          text: result.text,
          durationMs: result.durationMs,
        } satisfies StreamEvent);
        emitter.emit("done", {
          text: result.text,
          durationMs: result.durationMs,
        } satisfies BridgeTaskResult);
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        emitter.emit("event", { type: "error", message: msg } satisfies StreamEvent);
        emitter.emit("error", err instanceof Error ? err : new Error(msg));
      }
    };

    run();

    return {
      runner,
      events: emitter,
      cancel: () => { cancelled = true; },
    };
  }

  /**
   * Auto-detect which runner to use based on task content.
   */
  private detectRunner(params: RoutedTaskParams): RunnerType {
    if (params.subtasks && params.subtasks.length > 0) return "multi";
    if (params.command) return "script";

    // Use Codex for quick tasks if API key is available
    // Claude for deep reasoning, coding, multi-turn
    // Heuristic: short questions without code context → Codex is faster
    if (this.codexApiKey && !params.sessionId) {
      const msg = params.message.toLowerCase();
      const isQuickQuestion = params.message.length < 200
        && !msg.includes("code")
        && !msg.includes("implement")
        && !msg.includes("refactor")
        && !msg.includes("debug")
        && !msg.includes("analyze");
      if (isQuickQuestion) return "codex";
    }

    return "claude";
  }

  // ── Runner implementations ─────────────────────────────────────────

  private async runClaude(params: RoutedTaskParams): Promise<RoutedTaskResult> {
    const task = await this.bridgeService.submitTask({
      message: params.message,
      sessionId: params.sessionId,
      model: params.model,
      systemPrompt: params.systemPrompt,
      timeoutMs: params.timeoutMs,
    });

    if (task.status === "failed") {
      throw new Error(task.error ?? "Claude task failed");
    }

    return {
      runner: "claude",
      text: task.result?.text ?? "",
      durationMs: task.result?.durationMs ?? 0,
    };
  }

  private async runCodexTask(params: RoutedTaskParams): Promise<RoutedTaskResult> {
    if (!this.codexApiKey) {
      throw new Error("Codex API key not configured (set OPENAI_API_KEY)");
    }

    const result = await runCodex({
      prompt: params.message,
      model: params.model,
      systemPrompt: params.systemPrompt,
      timeoutMs: params.timeoutMs,
      apiKey: this.codexApiKey,
    });

    return {
      runner: "codex",
      text: result.text,
      durationMs: result.durationMs,
    };
  }

  private async runScriptTask(params: RoutedTaskParams): Promise<RoutedTaskResult> {
    if (!params.command) {
      throw new Error("Script runner requires a command");
    }

    const result = await runScript({
      command: params.command,
      args: params.args,
      cwd: params.cwd,
      timeoutMs: params.timeoutMs,
    });

    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `Script exited with code ${result.exitCode}`);
    }

    return {
      runner: "script",
      text: result.stdout,
      durationMs: result.durationMs,
    };
  }

  /**
   * Run multiple sub-tasks in parallel and combine results.
   * Each subtask can use a different runner.
   */
  private async runMulti(params: RoutedTaskParams): Promise<RoutedTaskResult> {
    const subtasks = params.subtasks ?? [];
    if (subtasks.length === 0) {
      throw new Error("Multi-agent task requires at least one subtask");
    }

    const started = Date.now();

    const results = await Promise.allSettled(
      subtasks.map((sub) =>
        this.route({
          message: sub.message,
          runner: sub.runner,
          model: sub.model,
          systemPrompt: sub.systemPrompt,
          timeoutMs: params.timeoutMs,
        }),
      ),
    );

    const subtaskResults = results.map((r, i) => {
      if (r.status === "fulfilled") {
        return {
          runner: subtasks[i].runner,
          text: r.value.text,
          durationMs: r.value.durationMs,
        };
      }
      return {
        runner: subtasks[i].runner,
        text: "",
        durationMs: 0,
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      };
    });

    // Combine results into a summary
    const combinedText = subtaskResults
      .map((r, i) => {
        const header = `## Subtask ${i + 1} (${r.runner})`;
        if (r.error) return `${header}\n\nError: ${r.error}`;
        return `${header}\n\n${r.text}`;
      })
      .join("\n\n---\n\n");

    return {
      runner: "multi",
      text: combinedText,
      durationMs: Date.now() - started,
      subtaskResults,
    };
  }
}
