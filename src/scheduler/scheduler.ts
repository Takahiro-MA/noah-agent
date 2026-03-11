import cron from "node-cron";
import fs from "node:fs";
import { JobStore } from "./job-store.js";
import type { JobState } from "./types.js";
import type { BridgeService } from "../core/bridge-service.js";

export type SchedulerConfig = {
  stateDir: string;
  schedulesDir: string;
  maxConcurrent?: number;
};

type ScheduledTask = {
  jobId: string;
  stop: () => void;
};

/**
 * Job scheduler that reads schedule definitions and executes them
 * using node-cron for cron expressions and setInterval for interval-based jobs.
 */
export class Scheduler {
  private readonly store: JobStore;
  private readonly service: BridgeService;
  private readonly config: SchedulerConfig;
  private readonly maxConcurrent: number;
  private readonly tasks: Map<string, ScheduledTask> = new Map();
  private readonly timers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private runningCount = 0;
  private watcher: fs.FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: SchedulerConfig, service: BridgeService) {
    this.config = config;
    this.store = new JobStore(config.stateDir, config.schedulesDir);
    this.service = service;
    this.maxConcurrent = config.maxConcurrent ?? 1;
  }

  /**
   * Start the scheduler: sync jobs, schedule them, and watch for changes.
   */
  start(): void {
    this.reload();

    // Watch for schedule file changes
    try {
      fs.mkdirSync(this.config.schedulesDir, { recursive: true });
      this.watcher = fs.watch(this.config.schedulesDir, { persistent: false }, (_event, filename) => {
        if (filename && filename.endsWith(".json")) {
          this.debouncedReload();
        }
      });
    } catch (err) {
      console.error("[scheduler] Failed to watch schedules directory:", err);
    }

    console.log(`[scheduler] Started with ${this.tasks.size} cron jobs, ${this.timers.size} interval jobs`);
  }

  /**
   * Stop all scheduled tasks and the file watcher.
   */
  stop(): void {
    for (const [, task] of this.tasks) {
      task.stop();
    }
    this.tasks.clear();

    for (const [, timer] of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();

    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    console.log("[scheduler] Stopped");
  }

  private debouncedReload(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      console.log("[scheduler] Schedule files changed, reloading...");
      this.reload();
    }, 1000);
  }

  private reload(): void {
    // Stop existing tasks
    for (const [, task] of this.tasks) {
      task.stop();
    }
    this.tasks.clear();
    for (const [, timer] of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();

    // Sync and schedule
    const jobs = this.store.sync();
    for (const job of jobs) {
      this.scheduleJob(job);
    }

    if (jobs.length > 0) {
      console.log(`[scheduler] Loaded ${jobs.length} jobs: ${jobs.map((j) => j.id).join(", ")}`);
    }
  }

  private scheduleJob(job: JobState): void {
    const { schedule } = job;

    if (schedule.kind === "cron") {
      if (!cron.validate(schedule.expr)) {
        console.error(`[scheduler] Invalid cron expression for ${job.id}: ${schedule.expr}`);
        return;
      }

      const task = cron.schedule(
        schedule.expr,
        () => {
          this.executeJob(job.id);
        },
        {
          timezone: schedule.tz,
        },
      );

      this.tasks.set(job.id, {
        jobId: job.id,
        stop: () => task.stop(),
      });
    } else if (schedule.kind === "every") {
      const run = () => {
        this.executeJob(job.id);
        const timer = setTimeout(run, schedule.everyMs);
        this.timers.set(job.id, timer);
      };

      // Calculate initial delay from anchor or start immediately
      const now = Date.now();
      const anchor = schedule.anchorMs ?? now;
      const elapsed = (now - anchor) % schedule.everyMs;
      const delay = elapsed === 0 ? 0 : schedule.everyMs - elapsed;

      const timer = setTimeout(run, delay);
      this.timers.set(job.id, timer);
    } else if (schedule.kind === "at") {
      const targetMs = new Date(schedule.at).getTime();
      const delay = targetMs - Date.now();
      if (delay <= 0) {
        // Already past, skip
        return;
      }

      const timer = setTimeout(() => {
        this.executeJob(job.id);
      }, delay);
      this.timers.set(job.id, timer);
    }
  }

  private async executeJob(jobId: string): Promise<void> {
    if (this.runningCount >= this.maxConcurrent) {
      console.log(`[scheduler] Skipping ${jobId}: max concurrent (${this.maxConcurrent}) reached`);
      return;
    }

    const jobs = this.store.list();
    const job = jobs.find((j) => j.id === jobId);
    if (!job || !job.enabled) return;

    // Check precondition before spawning Claude CLI
    if (job.precondition) {
      if (job.precondition.kind === "fileExists") {
        if (!fs.existsSync(job.precondition.path)) {
          console.log(`[scheduler] Skipping ${jobId}: precondition file not found (${job.precondition.path})`);
          return;
        }
      }
    }

    this.runningCount++;
    console.log(`[scheduler] Executing job: ${job.id} (${job.name})`);

    try {
      if (job.payload.kind === "agentTurn") {
        const task = await this.service.submitTask({
          message: job.payload.message,
          model: job.payload.model,
          timeoutMs: job.payload.timeoutSeconds
            ? job.payload.timeoutSeconds * 1000
            : undefined,
        });

        if (task.status === "completed") {
          console.log(`[scheduler] Job ${job.id} completed (${task.result?.durationMs}ms)`);
          this.store.recordRun(jobId);
        } else {
          const errMsg = task.error ?? `Task ended with status: ${task.status}`;
          console.error(`[scheduler] Job ${job.id} failed: ${errMsg}`);
          this.store.recordRun(jobId, errMsg);
        }
      } else if (job.payload.kind === "systemEvent") {
        // System events are logged only (no Claude invocation)
        console.log(`[scheduler] System event from ${job.id}: ${job.payload.text}`);
        this.store.recordRun(jobId);
      }

      // Handle deleteAfterRun
      if (job.deleteAfterRun) {
        this.store.removeJob(jobId);
        const task = this.tasks.get(jobId);
        if (task) {
          task.stop();
          this.tasks.delete(jobId);
        }
        const timer = this.timers.get(jobId);
        if (timer) {
          clearTimeout(timer);
          this.timers.delete(jobId);
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[scheduler] Job ${job.id} error: ${errMsg}`);
      this.store.recordRun(jobId, errMsg);
    } finally {
      this.runningCount--;
    }
  }

  listJobs(): JobState[] {
    return this.store.list();
  }
}
