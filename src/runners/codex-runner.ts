import https from "node:https";

export type CodexRunnerParams = {
  prompt: string;
  model?: string;
  systemPrompt?: string;
  timeoutMs?: number;
  apiKey: string;
  baseUrl?: string;
};

export type CodexResult = {
  text: string;
  model: string;
  durationMs: number;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
};

const DEFAULT_MODEL = "gpt-4.1";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_BASE_URL = "https://api.openai.com";

/**
 * Call OpenAI/Codex API directly via HTTPS.
 * No external SDK dependency — uses Node built-in https module.
 */
export function runCodex(params: CodexRunnerParams): Promise<CodexResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const model = params.model ?? DEFAULT_MODEL;
    const baseUrl = params.baseUrl ?? DEFAULT_BASE_URL;
    const url = new URL("/v1/chat/completions", baseUrl);

    const messages: Array<{ role: string; content: string }> = [];
    if (params.systemPrompt?.trim()) {
      messages.push({ role: "system", content: params.systemPrompt.trim() });
    }
    messages.push({ role: "user", content: params.prompt });

    const body = JSON.stringify({
      model,
      messages,
    });

    const req = https.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${params.apiKey}`,
        },
        timeout: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];

        res.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });

        res.on("end", () => {
          const durationMs = Date.now() - started;
          const raw = Buffer.concat(chunks).toString("utf-8");

          if (res.statusCode !== 200) {
            reject(new Error(`Codex API error (${res.statusCode}): ${raw.slice(0, 500)}`));
            return;
          }

          try {
            const parsed = JSON.parse(raw);
            const choice = parsed.choices?.[0];
            const text = choice?.message?.content ?? "";

            resolve({
              text,
              model: parsed.model ?? model,
              durationMs,
              usage: parsed.usage
                ? {
                    promptTokens: parsed.usage.prompt_tokens ?? 0,
                    completionTokens: parsed.usage.completion_tokens ?? 0,
                    totalTokens: parsed.usage.total_tokens ?? 0,
                  }
                : undefined,
            });
          } catch (err) {
            reject(new Error(`Failed to parse Codex response: ${err instanceof Error ? err.message : String(err)}`));
          }
        });
      },
    );

    req.on("error", (err) => {
      reject(new Error(`Codex API request failed: ${err.message}`));
    });

    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Codex API timed out after ${(params.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000}s`));
    });

    req.write(body);
    req.end();
  });
}
