import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { JobState, JobStoreFile, ScheduleDefinition } from "./types.js";

/**
 * Persistent job state storage.
 * Reads schedule definitions from config/schedules/*.json and manages
 * runtime state (lastRunAtMs, runCount, etc.) in a state file.
 */
export class JobStore {
  private data: JobStoreFile = { version: 1, jobs: {} };
  private readonly statePath: string;
  private readonly schedulesDir: string;

  constructor(stateDir: string, schedulesDir: string) {
    this.statePath = path.join(stateDir, "scheduler-state.json");
    this.schedulesDir = schedulesDir;
    this.loadState();
  }

  private loadState(): void {
    try {
      if (fs.existsSync(this.statePath)) {
        const raw = fs.readFileSync(this.statePath, "utf-8");
        this.data = JSON.parse(raw);
      }
    } catch {
      this.data = { version: 1, jobs: {} };
    }
  }

  private saveState(): void {
    const dir = path.dirname(this.statePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.statePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf-8");
    fs.renameSync(tmp, this.statePath);
  }

  /**
   * Scan config/schedules/*.json and sync with stored state.
   * Returns the current list of enabled jobs.
   */
  sync(): JobState[] {
    fs.mkdirSync(this.schedulesDir, { recursive: true });

    const files = fs.readdirSync(this.schedulesDir).filter((f) => f.endsWith(".json"));
    const foundIds = new Set<string>();

    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(this.schedulesDir, file), "utf-8");
        const def = JSON.parse(content) as ScheduleDefinition;
        const jobId = def.id ?? file.replace(/\.json$/, "");
        foundIds.add(jobId);

        const existing = this.data.jobs[jobId];
        const updated: JobState = {
          id: jobId,
          name: def.name,
          description: def.description ?? def.name,
          enabled: def.enabled !== false,
          schedule: def.schedule,
          payload: def.payload,
          deleteAfterRun: def.deleteAfterRun ?? false,
          lastRunAtMs: existing?.lastRunAtMs,
          lastError: existing?.lastError,
          runCount: existing?.runCount ?? 0,
          createdAtMs: existing?.createdAtMs ?? Date.now(),
        };
        this.data = {
          ...this.data,
          jobs: { ...this.data.jobs, [jobId]: updated },
        };
      } catch (err) {
        console.error(`[scheduler] Failed to parse ${file}:`, err);
      }
    }

    // Remove jobs whose schedule files no longer exist
    const toRemove = Object.keys(this.data.jobs).filter((id) => !foundIds.has(id));
    if (toRemove.length > 0) {
      const remaining = { ...this.data.jobs };
      for (const id of toRemove) {
        delete remaining[id];
      }
      this.data = { ...this.data, jobs: remaining };
    }

    this.saveState();
    return Object.values(this.data.jobs).filter((j) => j.enabled);
  }

  recordRun(jobId: string, error?: string): void {
    const job = this.data.jobs[jobId];
    if (!job) return;

    this.data = {
      ...this.data,
      jobs: {
        ...this.data.jobs,
        [jobId]: {
          ...job,
          lastRunAtMs: Date.now(),
          lastError: error,
          runCount: job.runCount + 1,
        },
      },
    };
    this.saveState();
  }

  removeJob(jobId: string): void {
    const { [jobId]: _, ...rest } = this.data.jobs;
    this.data = { ...this.data, jobs: rest };
    this.saveState();

    // Also remove the schedule file
    try {
      const filePath = path.join(this.schedulesDir, `${jobId}.json`);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // best-effort
    }
  }

  list(): JobState[] {
    return Object.values(this.data.jobs);
  }
}
