import { App } from "@slack/bolt";
import type { BridgeService } from "../core/bridge-service.js";
import type { BridgeTaskResult, StreamEvent } from "../core/types.js";
import { ThreadSessionStore } from "./thread-session-store.js";

export type SlackConfig = {
  botToken: string;
  appToken: string;
  stateDir: string;
  timeoutMs: number;
};

type SlackAdapter = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  getProtectedSessionIds: () => ReadonlySet<string>;
};

const FLUSH_INTERVAL_MS = 15_000;
const FLUSH_MIN_DELTA_CHARS = 50;
const MAX_SLACK_LENGTH = 3900;
const NEEDS_INPUT_MARKER = "<<NEEDS-INPUT>>";

function stripMarker(s: string): string {
  return s.split(NEEDS_INPUT_MARKER).join("");
}

/**
 * Create a Slack adapter that bridges DM messages to the BridgeService.
 *
 * - DMs are forwarded to Claude CLI via BridgeService
 * - Threads map to sessions for multi-turn conversations
 * - Streaming output is APPENDED as new threaded replies (never overwritten)
 * - The initial "thinking" message receives only status-marker edits
 */
export function createSlackAdapter(
  config: SlackConfig,
  service: BridgeService,
): SlackAdapter {
  const threadSessions = new ThreadSessionStore(config.stateDir);

  const app = new App({
    token: config.botToken,
    appToken: config.appToken,
    socketMode: true,
  });

  app.message(async ({ message, say, client }) => {
    const msg = message as { subtype?: string; bot_id?: string; text?: string; thread_ts?: string; ts: string; channel: string; user?: string };
    if (msg.subtype || msg.bot_id) return;

    const text = msg.text?.trim();
    if (!text) return;

    const threadTs = msg.thread_ts ?? msg.ts;
    const isInThread = Boolean(msg.thread_ts);

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

    // Status marker (never carries content — only state transitions)
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
          timeoutMs: config.timeoutMs,
        });

      threadSessions.set(threadTs, assignedSessionId);

      // Append-style flusher: posts new threaded replies with the delta
      let accumulated = "";
      let lastFlushedLength = 0;
      let flushInFlight = Promise.resolve();
      let awaitingInput = false;

      const flushDelta = async (force = false): Promise<void> => {
        const pending = accumulated.length - lastFlushedLength;
        if (!force && pending < FLUSH_MIN_DELTA_CHARS) return;
        if (pending <= 0) return;

        const delta = accumulated.slice(lastFlushedLength);
        lastFlushedLength = accumulated.length;

        // Chain flushes to keep ordering deterministic
        flushInFlight = flushInFlight.then(async () => {
          const chunks = splitMessage(delta, MAX_SLACK_LENGTH);
          for (const chunk of chunks) {
            try {
              await say({ text: chunk, thread_ts: threadTs });
            } catch (e) {
              console.error("[slack] Failed to post delta chunk:", e);
            }
          }
        });
        await flushInFlight;
      };

      let intervalTimer: ReturnType<typeof setInterval> | null = setInterval(() => {
        flushDelta(false).catch(() => {});
      }, FLUSH_INTERVAL_MS);

      const { text: resultText, timedOut } = await new Promise<{ text: string; timedOut: boolean }>((resolve) => {
        let settled = false;
        const settle = (finalText: string, timedOut: boolean) => {
          if (settled) return;
          settled = true;
          if (intervalTimer) {
            clearInterval(intervalTimer);
            intervalTimer = null;
          }
          resolve({ text: finalText, timedOut });
        };

        events.on("event", (evt: StreamEvent) => {
          if (evt.type === "text_delta") {
            accumulated = stripMarker(accumulated + evt.text);
          } else if (evt.type === "result") {
            // Final canonical text may differ from accumulated; sync up
            if (evt.text) {
              const cleaned = stripMarker(evt.text);
              if (cleaned.length > accumulated.length) accumulated = cleaned;
            }
          }
          // thinking_delta and others: ignore for output
        });

        events.on("done", (result: BridgeTaskResult) => {
          if (result.text) {
            const cleaned = stripMarker(result.text);
            if (cleaned.length > accumulated.length) accumulated = cleaned;
          }
          if (result.awaitingInput === true) awaitingInput = true;
          settle(accumulated, false);
        });

        events.on("error", (err: Error) => {
          console.error(`[slack] Stream error: ${err.message}`);
          settle(accumulated, true);
        });
      });

      // Flush any remaining delta as final chunk(s)
      await flushDelta(true);
      // Wait for any in-flight posts to complete
      await flushInFlight;

      // Update the status marker (no content, just a tag)
      if (progressTs) {
        let marker: string;
        if (awaitingInput) {
          marker = ":speech_balloon: _(質問中・応答待ち)_";
        } else if (timedOut) {
          marker = resultText.trim()
            ? ":warning: _(interrupted — partial result above)_"
            : ":warning: Processing took too long. Please try again or simplify your request.";
        } else {
          marker = ":white_check_mark: _(done)_";
        }
        await client.chat.update({
          channel: msg.channel,
          ts: progressTs,
          text: marker,
        }).catch(() => {});
      }

      // Safety net: if nothing was ever flushed (no text_delta events), post the
      // final text now so the user isn't left with only a status marker.
      if (lastFlushedLength === 0 && resultText.trim()) {
        const chunks = splitMessage(resultText, MAX_SLACK_LENGTH);
        for (const chunk of chunks) {
          await say({ text: chunk, thread_ts: threadTs }).catch(() => {});
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
