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

/**
 * Create a Slack adapter that bridges DM messages to the BridgeService.
 *
 * - DMs are forwarded to Claude CLI via BridgeService
 * - Threads map to sessions for multi-turn conversations
 * - Results are posted back as threaded replies
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
    // Only handle actual user messages (not bot messages, edits, etc.)
    const msg = message as { subtype?: string; bot_id?: string; text?: string; thread_ts?: string; ts: string; channel: string; user?: string };
    if (msg.subtype || msg.bot_id) return;

    const text = msg.text?.trim();
    if (!text) return;

    // Determine thread context
    const threadTs = msg.thread_ts ?? msg.ts;
    const isInThread = Boolean(msg.thread_ts);

    // Only respond in DMs (im channel type)
    try {
      const info = await client.conversations.info({ channel: msg.channel });
      const ch = info.channel as Record<string, unknown> | undefined;
      if (ch && !ch.is_im) {
        return; // Skip non-DM channels for now
      }
    } catch {
      // If we can't determine channel type, skip
      return;
    }

    // Resolve session: reuse if in an existing thread, create new otherwise
    let sessionId: string | undefined;
    if (isInThread && threadSessions.has(threadTs)) {
      sessionId = threadSessions.get(threadTs);
    }

    console.log(
      `[slack] Message from ${msg.user ?? "unknown"} in thread ${threadTs}: ${text.slice(0, 80)}${text.length > 80 ? "..." : ""}`,
    );

    // Post a "thinking" indicator
    const thinkingMsg = await say({
      text: ":hourglass_flowing_sand: Processing...",
      thread_ts: threadTs,
    });

    try {
      const { sessionId: assignedSessionId, events, cancel } =
        service.submitTaskStream({
          message: text,
          sessionId,
          streaming: true,
        });

      // Store thread → session mapping
      threadSessions.set(threadTs, assignedSessionId);

      // Wait for the result
      const resultText = await new Promise<string>((resolve, reject) => {
        let finalText = "";

        events.on("event", (evt: StreamEvent) => {
          if (evt.type === "result") {
            finalText = evt.text;
          }
        });

        events.on("done", (result: BridgeTaskResult) => {
          resolve(result.text || finalText);
        });

        events.on("error", (err: Error) => {
          reject(err);
        });
      });

      // Delete thinking message and post result
      if (thinkingMsg.ts) {
        await client.chat.delete({
          channel: msg.channel,
          ts: thinkingMsg.ts,
        }).catch(() => {
          // Best-effort delete (may lack permission)
        });
      }

      // Split long messages (Slack limit: ~4000 chars)
      const chunks = splitMessage(resultText, 3900);
      for (const chunk of chunks) {
        await say({ text: chunk, thread_ts: threadTs });
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[slack] Error processing message:`, errorMsg);

      // Delete thinking message and post error
      if (thinkingMsg.ts) {
        await client.chat.delete({
          channel: msg.channel,
          ts: thinkingMsg.ts,
        }).catch(() => {});
      }

      await say({
        text: `:x: Error: ${errorMsg.slice(0, 500)}`,
        thread_ts: threadTs,
      });
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

    // Try to split at a newline boundary
    let splitIdx = remaining.lastIndexOf("\n", maxLen);
    if (splitIdx < maxLen * 0.5) {
      // No good newline break, split at space
      splitIdx = remaining.lastIndexOf(" ", maxLen);
    }
    if (splitIdx < maxLen * 0.3) {
      // No good break point, hard split
      splitIdx = maxLen;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n/, "");
  }

  return chunks;
}
