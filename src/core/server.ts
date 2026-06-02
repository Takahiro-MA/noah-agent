import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { BridgeService } from "./bridge-service.js";
import { TaskRouter } from "./task-router.js";
import { Scheduler } from "../scheduler/scheduler.js";
import { createSlackAdapter } from "../slack/slack-adapter.js";
import type { NoahConfig } from "./types.js";
import { DEFAULTS } from "./types.js";

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let totalLength = 0;
  const maxBytes = 256 * 1024;

  for await (const chunk of req) {
    totalLength += (chunk as Buffer).length;
    if (totalLength > maxBytes) {
      throw new Error("Request body too large");
    }
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function parseJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function extractPathParam(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  const segment = rest.split("/")[0];
  return segment || null;
}

function loadConfig(): NoahConfig {
  const home = process.env.HOME ?? "/root";
  const projectRoot = process.env.NOAH_PROJECT_ROOT ?? path.join(home, "noah-agent");

  // Try to load config/default.json
  let fileConfig: Record<string, unknown> = {};
  try {
    const configPath = path.join(projectRoot, "config", "default.json");
    if (fs.existsSync(configPath)) {
      fileConfig = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    }
  } catch {
    // ignore
  }

  const stateDir = (typeof fileConfig.stateDir === "string" ? fileConfig.stateDir : null)
    ?? path.join(home, ".noah-agent", "state");
  const schedulesDir = (typeof fileConfig.schedulesDir === "string" ? fileConfig.schedulesDir : null)
    ?? path.join(projectRoot, "config", "schedules");

  return {
    port: Number(process.env.NOAH_PORT) || (typeof fileConfig.port === "number" ? fileConfig.port : DEFAULTS.port),
    model: process.env.NOAH_MODEL ?? (typeof fileConfig.model === "string" ? fileConfig.model : DEFAULTS.model),
    timeoutMs: Number(process.env.NOAH_TIMEOUT_MS) || (typeof fileConfig.timeoutMs === "number" ? fileConfig.timeoutMs : DEFAULTS.timeoutMs),
    watchdogMs: Number(process.env.NOAH_WATCHDOG_MS) || (typeof fileConfig.watchdogMs === "number" ? fileConfig.watchdogMs : DEFAULTS.watchdogMs),
    claudeCommand: process.env.NOAH_CLAUDE_COMMAND ?? (typeof fileConfig.claudeCommand === "string" ? fileConfig.claudeCommand : DEFAULTS.claudeCommand),
    workspaceDir: process.env.NOAH_WORKSPACE_DIR ?? (typeof fileConfig.workspaceDir === "string" ? fileConfig.workspaceDir : home),
    stateDir,
    schedulesDir,
    sessionIdleMs: typeof fileConfig.sessionIdleMs === "number" ? fileConfig.sessionIdleMs : DEFAULTS.sessionIdleMs,
    sessionExpireMs: typeof fileConfig.sessionExpireMs === "number" ? fileConfig.sessionExpireMs : DEFAULTS.sessionExpireMs,
  };
}

async function main() {
  const config = loadConfig();

  const service = new BridgeService(config);
  const router = new TaskRouter(service, process.env.OPENAI_API_KEY);

  // Start scheduler
  const scheduler = new Scheduler(
    { stateDir: config.stateDir, schedulesDir: config.schedulesDir },
    service,
  );
  scheduler.start();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const pathname = url.pathname;

    try {
      // Health check
      if (pathname === "/health" && req.method === "GET") {
        sendJson(res, 200, { ok: true, service: "noah-agent", pid: process.pid });
        return;
      }

      // Submit task
      if (pathname === "/task" && req.method === "POST") {
        const body = await parseJsonBody(req);
        const message = typeof body.message === "string" ? body.message.trim() : "";
        if (!message) {
          sendJson(res, 400, {
            ok: false,
            error: { type: "invalid_request", message: "message is required" },
          });
          return;
        }

        const taskParams = {
          message,
          sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
          model: typeof body.model === "string" ? body.model : undefined,
          systemPrompt: typeof body.systemPrompt === "string" ? body.systemPrompt : undefined,
          timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : undefined,
          streaming: body.streaming === true,
        };

        // Streaming mode: SSE
        if (taskParams.streaming) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Content-Type-Options": "nosniff",
          });

          const { taskId, sessionId, events, cancel } = service.submitTaskStream(taskParams);

          // Send initial metadata
          res.write(`data: ${JSON.stringify({ type: "start", taskId, sessionId })}\n\n`);

          events.on("event", (evt: unknown) => {
            if (!res.destroyed) {
              res.write(`data: ${JSON.stringify(evt)}\n\n`);
            }
          });

          events.on("done", () => {
            if (!res.destroyed) {
              res.write("data: [DONE]\n\n");
              res.end();
            }
          });

          events.on("error", () => {
            if (!res.destroyed) {
              res.write("data: [DONE]\n\n");
              res.end();
            }
          });

          // Client disconnect → kill process
          req.on("close", () => {
            cancel();
          });
          return;
        }

        // Non-streaming mode: wait for completion
        const task = await service.submitTask(taskParams);

        sendJson(res, 200, {
          ok: true,
          taskId: task.taskId,
          sessionId: task.sessionId,
          status: task.status,
          response: task.result
            ? { text: task.result.text, durationMs: task.result.durationMs }
            : undefined,
          error: task.error,
        });
        return;
      }

      // Get task status
      const taskId = extractPathParam(pathname, "/task/");
      if (taskId && req.method === "GET") {
        const task = service.getTask(taskId);
        if (!task) {
          sendJson(res, 404, { ok: false, error: { type: "not_found", message: "Task not found" } });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          taskId: task.taskId,
          sessionId: task.sessionId,
          status: task.status,
          response: task.result
            ? { text: task.result.text, durationMs: task.result.durationMs }
            : undefined,
          error: task.error,
        });
        return;
      }

      // Cancel task
      if (taskId && req.method === "DELETE") {
        const cancelled = service.cancelTask(taskId);
        sendJson(res, cancelled ? 200 : 404, {
          ok: cancelled,
          ...(cancelled
            ? {}
            : { error: { type: "not_found", message: "Task not found or not cancellable" } }),
        });
        return;
      }

      // List sessions
      if (pathname === "/sessions" && req.method === "GET") {
        sendJson(res, 200, { ok: true, sessions: service.listSessions() });
        return;
      }

      // Delete session
      const sessionId = extractPathParam(pathname, "/session/");
      if (sessionId && req.method === "DELETE") {
        const deleted = service.deleteSession(sessionId);
        sendJson(res, deleted ? 200 : 404, {
          ok: deleted,
          ...(deleted
            ? {}
            : { error: { type: "not_found", message: "Session not found" } }),
        });
        return;
      }

      // List scheduled jobs
      if (pathname === "/schedules" && req.method === "GET") {
        sendJson(res, 200, { ok: true, jobs: scheduler.listJobs() });
        return;
      }

      // Routed task (multi-agent capable)
      if (pathname === "/route" && req.method === "POST") {
        const body = await parseJsonBody(req);
        const message = typeof body.message === "string" ? body.message.trim() : "";
        if (!message) {
          sendJson(res, 400, {
            ok: false,
            error: { type: "invalid_request", message: "message is required" },
          });
          return;
        }

        const routeParams = {
          message,
          runner: typeof body.runner === "string" ? body.runner as "claude" | "codex" | "script" | "multi" : undefined,
          sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
          model: typeof body.model === "string" ? body.model : undefined,
          systemPrompt: typeof body.systemPrompt === "string" ? body.systemPrompt : undefined,
          timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : undefined,
          command: typeof body.command === "string" ? body.command : undefined,
          args: Array.isArray(body.args) ? body.args as string[] : undefined,
          cwd: typeof body.cwd === "string" ? body.cwd : undefined,
          subtasks: Array.isArray(body.subtasks) ? body.subtasks as Array<{
            runner: "claude" | "codex" | "script" | "multi";
            message: string;
            model?: string;
            systemPrompt?: string;
          }> : undefined,
        };

        try {
          const result = await router.route(routeParams);
          sendJson(res, 200, { ok: true, ...result });
        } catch (err) {
          sendJson(res, 500, {
            ok: false,
            error: {
              type: "runner_error",
              message: err instanceof Error ? err.message : String(err),
            },
          });
        }
        return;
      }

      // Not found
      sendJson(res, 404, { ok: false, error: { type: "not_found", message: "Route not found" } });
    } catch (err) {
      console.error("[noah] Error:", err);
      sendJson(res, 500, {
        ok: false,
        error: {
          type: "internal_error",
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  });

  // Start Slack adapter if tokens are configured
  let slackAdapter: ReturnType<typeof createSlackAdapter> | null = null;
  const slackBotToken = process.env.SLACK_BOT_TOKEN;
  const slackAppToken = process.env.SLACK_APP_TOKEN;
  if (slackBotToken && slackAppToken) {
    try {
      slackAdapter = createSlackAdapter(
        { botToken: slackBotToken, appToken: slackAppToken, stateDir: config.stateDir, timeoutMs: config.timeoutMs },
        service,
      );
      service.setProtectedSessionIdsFn(() => slackAdapter!.getProtectedSessionIds());
      await slackAdapter.start();
    } catch (err) {
      console.error("[noah-agent] Failed to start Slack adapter:", err);
      slackAdapter = null;
    }
  } else {
    console.log("[noah-agent] Slack not configured (set SLACK_BOT_TOKEN and SLACK_APP_TOKEN)");
  }

  server.listen(config.port, "0.0.0.0", () => {
    console.log(`[noah-agent] Listening on 0.0.0.0:${config.port}`);
    console.log(`[noah-agent] Claude command: ${config.claudeCommand}`);
    console.log(`[noah-agent] Workspace: ${config.workspaceDir}`);
    console.log(`[noah-agent] Schedules: ${config.schedulesDir}`);
  });

  const shutdown = async () => {
    console.log("[noah-agent] Shutting down...");
    scheduler.stop();
    if (slackAdapter) await slackAdapter.stop();
    service.shutdown();
    server.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main();
