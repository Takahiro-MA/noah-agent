import { spawn } from "node:child_process";

export type ScriptRunnerParams = {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
};

export type ScriptResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
};

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Execute a script or command as a subprocess.
 * Used for running Python scripts, shell commands, etc.
 */
export function runScript(params: ScriptRunnerParams): Promise<ScriptResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(params.env ?? {}),
    };

    const proc = spawn(params.command, params.args ?? [], {
      cwd: params.cwd ?? process.cwd(),
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL");
      }, 5000);
      reject(new Error(`Script timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);

    proc.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn script: ${err.message}`));
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
        exitCode: code ?? 1,
        durationMs: Date.now() - started,
      });
    });

    proc.stdin.end();
  });
}
