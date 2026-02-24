import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import type { BridgeTaskResult, StreamEvent } from "./types.js";

export type ClaudeRunnerParams = {
  prompt: string;
  claudeSessionId: string;
  isResume: boolean;
  model: string;
  systemPrompt?: string;
  workspaceDir: string;
  claudeCommand: string;
  timeoutMs: number;
  watchdogMs: number;
  streaming?: boolean;
};

function buildArgs(params: ClaudeRunnerParams): string[] {
  const fmt = params.streaming ? "stream-json" : "json";
  const args: string[] = ["-p", "--output-format", fmt, "--dangerously-skip-permissions"];
  if (params.streaming) {
    args.push("--verbose");
  }

  if (params.isResume) {
    args.push("--resume", params.claudeSessionId);
  } else {
    args.push("--session-id", params.claudeSessionId);
    args.push("--model", params.model);
  }

  if (!params.isResume && params.systemPrompt?.trim()) {
    args.push("--append-system-prompt", params.systemPrompt.trim());
  }

  args.push(params.prompt);
  return args;
}

function parseJsonOutput(stdout: string): { text: string; sessionId?: string } | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;

  try {
    const parsed = JSON.parse(trimmed);
    const text =
      typeof parsed.result === "string"
        ? parsed.result
        : typeof parsed.message === "string"
          ? parsed.message
          : typeof parsed.content === "string"
            ? parsed.content
            : typeof parsed.text === "string"
              ? parsed.text
              : null;

    const sessionId =
      typeof parsed.session_id === "string"
        ? parsed.session_id
        : typeof parsed.sessionId === "string"
          ? parsed.sessionId
          : typeof parsed.conversation_id === "string"
            ? parsed.conversation_id
            : undefined;

    if (text !== null) {
      return { text, sessionId };
    }
    return { text: trimmed, sessionId };
  } catch {
    return { text: trimmed };
  }
}

function buildEnv(): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_API_KEY_OLD;
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE;
  return env as NodeJS.ProcessEnv;
}

export function runClaudeBridge(params: ClaudeRunnerParams): Promise<BridgeTaskResult> {
  return new Promise((resolve, reject) => {
    const args = buildArgs(params);
    const started = Date.now();
    const env = buildEnv();

    const proc = spawn(params.claudeCommand, args, {
      cwd: params.workspaceDir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    // Watchdog: kill if no output for watchdogMs
    let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
    const resetWatchdog = () => {
      if (watchdogTimer) clearTimeout(watchdogTimer);
      watchdogTimer = setTimeout(() => {
        proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
        }, 5000);
        reject(
          new Error(
            `Claude CLI produced no output for ${Math.round(params.watchdogMs / 1000)}s`,
          ),
        );
      }, params.watchdogMs);
    };

    // Overall timeout
    const overallTimer = setTimeout(() => {
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL");
      }, 5000);
      reject(
        new Error(
          `Claude CLI exceeded timeout (${Math.round(params.timeoutMs / 1000)}s)`,
        ),
      );
    }, params.timeoutMs);

    resetWatchdog();

    proc.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      resetWatchdog();
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      resetWatchdog();
    });

    proc.on("error", (err) => {
      if (watchdogTimer) clearTimeout(watchdogTimer);
      clearTimeout(overallTimer);
      reject(new Error(`Failed to spawn Claude CLI: ${err.message}`));
    });

    proc.on("close", (code) => {
      if (watchdogTimer) clearTimeout(watchdogTimer);
      clearTimeout(overallTimer);

      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");
      const durationMs = Date.now() - started;

      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `CLI exited with code ${code}`));
        return;
      }

      const parsed = parseJsonOutput(stdout);
      if (!parsed) {
        reject(new Error("Claude CLI returned empty output"));
        return;
      }

      resolve({
        text: parsed.text,
        claudeSessionId: parsed.sessionId,
        durationMs,
      });
    });

    // Close stdin immediately since we pass prompt via args
    proc.stdin.end();
  });
}

/**
 * Parse a single NDJSON line from `--output-format stream-json` into StreamEvents.
 *
 * Claude CLI stream-json format:
 *   {"type":"system","subtype":"init",...}  → skip
 *   {"type":"assistant","message":{"content":[{"type":"text","text":"..."}],...}} → extract
 *   {"type":"result","result":"...","duration_ms":N,"session_id":"..."} → final
 */
function parseStreamLine(line: string): StreamEvent[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }

  const type = parsed.type as string | undefined;

  // Result event (final)
  if (type === "result") {
    return [{
      type: "result",
      text: typeof parsed.result === "string" ? parsed.result : "",
      durationMs: typeof parsed.duration_ms === "number" ? parsed.duration_ms : 0,
      sessionId:
        typeof parsed.session_id === "string"
          ? parsed.session_id
          : undefined,
    }];
  }

  // Assistant message: extract content blocks
  if (type === "assistant") {
    const msg = parsed.message as Record<string, unknown> | undefined;
    const content = msg?.content as Array<Record<string, unknown>> | undefined;
    if (!content || !Array.isArray(content)) return [];

    const events: StreamEvent[] = [];
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string") {
        events.push({ type: "text_delta", text: block.text });
      } else if (block.type === "thinking" && typeof block.thinking === "string") {
        events.push({ type: "thinking_delta", text: block.thinking });
      } else if (block.type === "tool_use") {
        events.push({
          type: "tool_use",
          name: typeof block.name === "string" ? block.name : "unknown",
          input: typeof block.input === "string" ? block.input : JSON.stringify(block.input ?? {}),
        });
      }
    }
    return events;
  }

  return [];
}

export type StreamHandle = {
  events: EventEmitter;
  cancel: () => void;
};

/**
 * Streaming variant of runClaudeBridge.
 * Emits StreamEvents via EventEmitter as Claude CLI produces NDJSON output.
 *
 * Events:
 *   "event"  (StreamEvent)      - each parsed stream event
 *   "done"   (BridgeTaskResult) - final result when process exits successfully
 *   "error"  (Error)            - on failure
 */
export function runClaudeBridgeStream(params: ClaudeRunnerParams): StreamHandle {
  const emitter = new EventEmitter();
  const args = buildArgs({ ...params, streaming: true });
  const started = Date.now();
  const env = buildEnv();

  const proc = spawn(params.claudeCommand, args, {
    cwd: params.workspaceDir,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let cancelled = false;
  let lineBuf = "";
  let lastResultEvent: StreamEvent | null = null;
  const stderrChunks: Buffer[] = [];

  // Watchdog
  let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
  const resetWatchdog = () => {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    if (cancelled) return;
    watchdogTimer = setTimeout(() => {
      const err = new Error(
        `Claude CLI produced no output for ${Math.round(params.watchdogMs / 1000)}s`,
      );
      killProc();
      emitter.emit("event", { type: "error", message: err.message } satisfies StreamEvent);
      emitter.emit("error", err);
    }, params.watchdogMs);
  };

  // Overall timeout
  const overallTimer = setTimeout(() => {
    const err = new Error(
      `Claude CLI exceeded timeout (${Math.round(params.timeoutMs / 1000)}s)`,
    );
    killProc();
    emitter.emit("event", { type: "error", message: err.message } satisfies StreamEvent);
    emitter.emit("error", err);
  }, params.timeoutMs);

  function killProc() {
    cancelled = true;
    if (watchdogTimer) clearTimeout(watchdogTimer);
    clearTimeout(overallTimer);
    proc.kill("SIGTERM");
    setTimeout(() => {
      if (!proc.killed) proc.kill("SIGKILL");
    }, 5000);
  }

  resetWatchdog();

  proc.stdout.on("data", (chunk: Buffer) => {
    resetWatchdog();
    lineBuf += chunk.toString("utf-8");

    // Process complete lines
    let newlineIdx: number;
    while ((newlineIdx = lineBuf.indexOf("\n")) !== -1) {
      const line = lineBuf.slice(0, newlineIdx);
      lineBuf = lineBuf.slice(newlineIdx + 1);

      const events = parseStreamLine(line);
      for (const event of events) {
        if (event.type === "result") {
          lastResultEvent = event;
        }
        emitter.emit("event", event);
      }
    }
  });

  proc.stderr.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk);
    resetWatchdog();
  });

  proc.on("error", (err) => {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    clearTimeout(overallTimer);
    const wrapped = new Error(`Failed to spawn Claude CLI: ${err.message}`);
    emitter.emit("event", { type: "error", message: wrapped.message } satisfies StreamEvent);
    emitter.emit("error", wrapped);
  });

  proc.on("close", (code) => {
    if (watchdogTimer) clearTimeout(watchdogTimer);
    clearTimeout(overallTimer);

    if (cancelled) return;

    const durationMs = Date.now() - started;
    const stderr = Buffer.concat(stderrChunks).toString("utf-8");

    if (code !== 0) {
      const msg = stderr.trim() || `CLI exited with code ${code}`;
      emitter.emit("event", { type: "error", message: msg } satisfies StreamEvent);
      emitter.emit("error", new Error(msg));
      return;
    }

    // Build final result from the last "result" event
    const result: BridgeTaskResult = {
      text: lastResultEvent?.type === "result" ? lastResultEvent.text : "",
      claudeSessionId:
        lastResultEvent?.type === "result" ? lastResultEvent.sessionId : undefined,
      durationMs,
    };

    emitter.emit("done", result);
  });

  proc.stdin.end();

  return {
    events: emitter,
    cancel: killProc,
  };
}
