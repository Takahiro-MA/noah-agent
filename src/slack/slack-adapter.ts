import { App } from "@slack/bolt";
import type { BridgeService } from "../core/bridge-service.js";
import type { BridgeTaskResult, StreamEvent } from "../core/types.js";

export type SlackConfig = {
  botToken: string;
  appToken: string;
};

type SlackAdapter = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

const UPDATE_INTERVAL_MS = 2000;
const MAX_SLACK_LENGTH = 3900;

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
  // Thread timestamp → bridge session ID mapping
  const threadSessions = new Map<string, string>();

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

    // Only respond in DMs
    try {
      const info = await client.conversations.info({ channel: msg.channel });
      const ch = info.channel as Record<string, unknown> | undefined;
      if (ch && !ch.is_im) {
        return;
      }
    } catch {
      return;
    }

    let sessionId: string | undefined;
    if (isInThread && threadSessions.has(threadTs)) {
      sessionId = threadSessions.get(threadTs);
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
        });

      threadSessions.set(threadTs, assignedSessionId);

      // Progressive streaming update
      const resultText = await new Promise<string>((resolve, reject) => {
        let accumulated = "";
        let lastUpdateAt = 0;
        let updateTimer: ReturnType<typeof setTimeout> | null = null;
        let isThinking = true;

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
          if (updateTimer) clearTimeout(updateTimer);
          resolve(result.text || accumulated);
        });

        events.on("error", (err: Error) => {
          if (updateTimer) clearTimeout(updateTimer);
          reject(err);
        });
      });

      // Final update: replace progress message with final result
      if (progressTs) {
        const chunks = splitMessage(resultText, MAX_SLACK_LENGTH);
        // Update first message in-place
        await client.chat.update({
          channel: msg.channel,
          ts: progressTs,
          text: chunks[0],
        }).catch(() => {});

        // Post additional chunks as separate messages
        for (let i = 1; i < chunks.length; i++) {
          await say({ text: chunks[i], thread_ts: threadTs });
        }
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
