import { App } from "@slack/bolt";
import type { BridgeService } from "../core/bridge-service.js";
import type { BridgeTaskResult, StreamEvent } from "../core/types.js";
import { ThreadSessionStore } from "./thread-session-store.js";

export type SlackConfig = {
  botToken: string;
  appToken: string;
  stateDir: string;
};

type SlackAdapter = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  getProtectedSessionIds: () => ReadonlySet<string>;
};

const UPDATE_INTERVAL_MS = 2000;
const MAX_SLACK_LENGTH = 3900;
const SLACK_TIMEOUT_MS = 600_000; // 10 min — generous for long Claude tasks

/**
 * Create a Slack adapter that bridges DM messages to the BridgeService.
 *
 * - DMs are forwarded to Claude CLI via BridgeService
 * - Threads map to sessions for multi-turn conversations
 * - Streaming text is progressively updated in Slack (chat.update)
 * - Results are posted as threaded replies
 */
export function createSlackAdapter(
  config: SlackConfig,
  service: BridgeService,
): SlackAdapter {
  // Thread timestamp → bridge session ID mapping (persisted to disk)
  const threadSessions = new ThreadSessionStore(config.stateDir);

  const app = new App({
    token: config.botToken,
    appToken: config.appToken,
    socketMode: true,
  });

  // Handle DM messages
  app.message(async ({ message, say, client }) => {
    const msg = message as { subtype?: string; bot_id?: string; text?: string; thread_ts?: string; ts: string; channel: string; user?: string };
    if (msg.subtype || msg.bot_id) return;

    const text = msg.text?.trim();
    if (!text) return;

    const threadTs = msg.thread_ts ?? msg.ts;
    const isInThread = Boolean(msg.thread_ts);

    // Only respond in DMs (use channel_type from event payload — no extra API call needed)
    const channelType = (message as { channel_type?: string }).channel_type;
    if (channelType !== "im") {
      return;
    }

    let sessionId: string | undefined;
    const existingSession = threadSessions.get(threadTs);
    if (isInThread && existingSession) {
      sessionId = existingSession;
    }

    console.log(
      `[slack] Message from ${msg.user ?? "unknown"} in thread ${threadTs}: ${text.slice(0, 80)}${text.length > 80 ? "..." : ""}`,
    );

    // Post initial "thinking" message (will be updated progressively)
    const progressMsg = await say({
      text: ":hourglass_flowing_sand: Thinking...",
      thread_ts: threadTs,
    });

    const progressTs = progressMsg.ts;

    try {
      const { sessionId: assignedSessionId, events } =
        service.submitTaskStream({
          message: text,
          sessionId,
          streaming: true,
          timeoutMs: SLACK_TIMEOUT_MS,
        });

      threadSessions.set(threadTs, assignedSessionId);

      // Progressive streaming update
      const { text: resultText, timedOut } = await new Promise<{ text: string; timedOut: boolean }>((resolve) => {
        let accumulated = "";
        let lastUpdateAt = 0;
        let updateTimer: ReturnType<typeof setTimeout> | null = null;
        let isThinking = true;
        let settled = false;

        const finish = (finalText: string, timedOut: boolean) => {
          if (settled) return;
          settled = true;
          if (updateTimer) clearTimeout(updateTimer);
          resolve({ text: finalText, timedOut });
        };

        const updateSlackMessage = () => {
          if (!progressTs || !accumulated) return;

          const display = accumulated.length > MAX_SLACK_LENGTH
            ? accumulated.slice(0, MAX_SLACK_LENGTH) + "\n\n... _(truncated, full response follows)_"
            : accumulated;

          const prefix = isThinking ? ":brain: " : "";
          const suffix = "\n\n:writing_hand: _generating..._";

          client.chat.update({
            channel: msg.channel,
            ts: progressTs,
            text: prefix + display + suffix,
          }).catch(() => {
            // Best-effort update
          });

          lastUpdateAt = Date.now();
        };

        const scheduleUpdate = () => {
          if (updateTimer) return;
          const elapsed = Date.now() - lastUpdateAt;
          const delay = Math.max(0, UPDATE_INTERVAL_MS - elapsed);
          updateTimer = setTimeout(() => {
            updateTimer = null;
            updateSlackMessage();
          }, delay);
        };

        events.on("event", (evt: StreamEvent) => {
          if (evt.type === "text_delta") {
            isThinking = false;
            accumulated += evt.text;
            scheduleUpdate();
          } else if (evt.type === "thinking_delta") {
            isThinking = true;
          } else if (evt.type === "result") {
            accumulated = evt.text || accumulated;
          }
        });

        events.on("done", (result: BridgeTaskResult) => {
          finish(result.text || accumulated, false);
        });

        events.on("error", (err: Error) => {
          console.error(`[slack] Stream error: ${err.message}`);
          // On timeout/error, use whatever we accumulated so far
          // instead of showing an error to the user
          if (accumulated.trim()) {
            finish(accumulated, true);
          } else {
            finish(`:warning: Processing took too long. Please try again or simplify your request.`, true);
          }
        });
      });

      // Final result: post as a NEW message (ensures Push notification)
      // and clean up the progress message
      if (progressTs) {
        // Remove the progress message (replace with minimal text)
        await client.chat.update({
          channel: msg.channel,
          ts: progressTs,
          text: timedOut
            ? ":hourglass: _(response was interrupted — partial result below)_"
            : ":white_check_mark: _(done)_",
        }).catch(() => {});
      }

      // Post final result as new thread reply — this triggers Push notification
      const chunks = splitMessage(resultText, MAX_SLACK_LENGTH);
      for (const chunk of chunks) {
        await say({ text: chunk, thread_ts: threadTs });
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[slack] Error processing message:`, errorMsg);

      if (progressTs) {
        await client.chat.update({
          channel: msg.channel,
          ts: progressTs,
          text: `:x: Error: ${errorMsg.slice(0, 500)}`,
        }).catch(() => {});
      }
    }
  });

  return {
    async start() {
      await app.start();
      console.log("[noah-agent] Slack connected (Socket Mode)");
    },
    async stop() {
      await app.stop();
      console.log("[noah-agent] Slack disconnected");
    },
    getProtectedSessionIds() {
      return threadSessions.allSessionIds();
    },
  };
}

/**
 * Split a message into chunks that fit within Slack's message size limit.
 */
function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    let splitIdx = remaining.lastIndexOf("\n", maxLen);
    if (splitIdx < maxLen * 0.5) {
      splitIdx = remaining.lastIndexOf(" ", maxLen);
    }
    if (splitIdx < maxLen * 0.3) {
      splitIdx = maxLen;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n/, "");
  }

  return chunks;
}
