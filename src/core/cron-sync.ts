/**
 * Schedule Sync Worker
 *
 * Watches config/schedules/*.json for schedule definitions.
 * Manages an internal job store for the scheduler.
 *
 * Jobs managed by this worker are tagged with `managedBy: "automation"` in
 * their description prefix, so the worker only touches its own jobs.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const MANAGED_TAG = "[auto]";

// ── Types ──────────────────────────────────────────────────────────────

type ScheduleDefinition = {
  /** Job ID. Defaults to filename (without .json) */
  id?: string;
  name: string;
  description?: string;
  enabled?: boolean;
  schedule:
    | { kind: "at"; at: string }
    | { kind: "every"; everyMs: number; anchorMs?: number }
    | { kind: "cron"; expr: string; tz?: string; staggerMs?: number };
  sessionTarget?: "main" | "isolated";
  wakeMode?: "now" | "next-heartbeat";
  payload:
    | { kind: "systemEvent"; text: string }
    | {
        kind: "agentTurn";
        message: string;
        model?: string;
        thinking?: string;
        timeoutSeconds?: number;
      };
  delivery?:
    | { mode: "none" }
    | { mode: "announce"; channel?: string; to?: string; bestEffort?: boolean }
    | { mode: "webhook"; to: string; bestEffort?: boolean };
  deleteAfterRun?: boolean;
};

type CronJob = Record<string, unknown>;
type CronStoreFile = { version: number; jobs: CronJob[] };
type SyncState = Record<string, { hash: string; updatedAt: number }>;

// ── Config ────────────────────────────────────────────────────────────

let SCHEDULES_DIR = path.join(process.cwd(), "config", "schedules");
let CRON_STORE_PATH = path.join(process.env.HOME ?? "/root", ".noah-agent", "state", "jobs.json");
let SYNC_STATE_PATH = path.join(process.env.HOME ?? "/root", ".noah-agent", "state", ".sync-state.json");

export function configurePaths(opts: {
  schedulesDir?: string;
  stateDir?: string;
}): void {
  if (opts.schedulesDir) {
    SCHEDULES_DIR = opts.schedulesDir;
  }
  if (opts.stateDir) {
    CRON_STORE_PATH = path.join(opts.stateDir, "jobs.json");
    SYNC_STATE_PATH = path.join(opts.stateDir, ".sync-state.json");
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

function fileHash(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function loadJsonFile<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return fallback;
  }
}

function saveJsonFileAtomic(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  fs.renameSync(tmp, filePath);
}

function isManaged(job: CronJob): boolean {
  const desc = String(job.description ?? "");
  return desc.startsWith(MANAGED_TAG);
}

function scheduleToJob(def: ScheduleDefinition, jobId: string): CronJob {
  const now = Date.now();
  const description = `${MANAGED_TAG} ${def.description ?? def.name}`;
  return {
    id: jobId,
    name: def.name,
    description,
    enabled: def.enabled !== false,
    schedule: def.schedule,
    sessionTarget: def.sessionTarget ?? "isolated",
    wakeMode: def.wakeMode ?? "now",
    payload: def.payload,
    delivery: def.delivery ?? { mode: "none" },
    deleteAfterRun: def.deleteAfterRun ?? false,
    createdAtMs: now,
    updatedAtMs: now,
    state: {
      nextRunAtMs: undefined,
      consecutiveErrors: 0,
    },
  };
}

// ── Core Sync Logic ────────────────────────────────────────────────────

type SyncResult = {
  added: string[];
  updated: string[];
  removed: string[];
  errors: string[];
};

export function syncSchedules(): SyncResult {
  const result: SyncResult = { added: [], updated: [], removed: [], errors: [] };

  // 1. Read schedule definitions
  const scheduleFiles = new Map<string, { def: ScheduleDefinition; hash: string }>();
  try {
    if (!fs.existsSync(SCHEDULES_DIR)) {
      fs.mkdirSync(SCHEDULES_DIR, { recursive: true });
    }
    const files = fs.readdirSync(SCHEDULES_DIR).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      try {
        const filePath = path.join(SCHEDULES_DIR, file);
        const content = fs.readFileSync(filePath, "utf-8");
        const def = JSON.parse(content) as ScheduleDefinition;
        const jobId = def.id ?? file.replace(/\.json$/, "");
        scheduleFiles.set(jobId, { def, hash: fileHash(content) });
      } catch (err) {
        result.errors.push(`Failed to parse ${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } catch (err) {
    result.errors.push(`Failed to read schedules dir: ${err instanceof Error ? err.message : String(err)}`);
    return result;
  }

  // 2. Load current job store
  const store = loadJsonFile<CronStoreFile>(CRON_STORE_PATH, { version: 1, jobs: [] });
  const jobs = Array.isArray(store.jobs) ? [...store.jobs] : [];

  // 3. Load previous sync state
  const syncState = loadJsonFile<SyncState>(SYNC_STATE_PATH, {});
  const newSyncState: SyncState = {};

  // 4. Build index of existing managed jobs
  const managedJobIndex = new Map<string, number>();
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    if (isManaged(job) && typeof job.id === "string") {
      managedJobIndex.set(job.id, i);
    }
  }

  // 5. Add or update jobs
  for (const [jobId, { def, hash }] of scheduleFiles) {
    newSyncState[jobId] = { hash, updatedAt: Date.now() };
    const existingIdx = managedJobIndex.get(jobId);

    if (existingIdx !== undefined) {
      const prevHash = syncState[jobId]?.hash;
      if (prevHash === hash) {
        managedJobIndex.delete(jobId);
        continue;
      }
      const existing = jobs[existingIdx];
      const updated = scheduleToJob(def, jobId);
      updated.createdAtMs = existing.createdAtMs ?? updated.createdAtMs;
      updated.state = existing.state ?? updated.state;
      updated.updatedAtMs = Date.now();
      jobs[existingIdx] = updated;
      result.updated.push(jobId);
      managedJobIndex.delete(jobId);
    } else {
      jobs.push(scheduleToJob(def, jobId));
      result.added.push(jobId);
    }
  }

  // 6. Remove managed jobs that no longer have a schedule file
  const toRemoveIndices: number[] = [];
  for (const [jobId, idx] of managedJobIndex) {
    toRemoveIndices.push(idx);
    result.removed.push(jobId);
  }
  toRemoveIndices.sort((a, b) => b - a);
  for (const idx of toRemoveIndices) {
    jobs.splice(idx, 1);
  }

  // 7. Save if anything changed
  if (result.added.length > 0 || result.updated.length > 0 || result.removed.length > 0) {
    saveJsonFileAtomic(CRON_STORE_PATH, { version: 1, jobs });
    try {
      fs.copyFileSync(CRON_STORE_PATH, `${CRON_STORE_PATH}.bak`);
    } catch {
      // best-effort
    }
  }

  // 8. Save sync state
  saveJsonFileAtomic(SYNC_STATE_PATH, newSyncState);

  return result;
}

// ── File Watcher ───────────────────────────────────────────────────────

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let watcher: fs.FSWatcher | null = null;

function onScheduleChange() {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    try {
      const result = syncSchedules();
      const changes =
        result.added.length + result.updated.length + result.removed.length;
      if (changes > 0) {
        console.log(
          `[scheduler] Synced: +${result.added.length} ~${result.updated.length} -${result.removed.length}`,
        );
        if (result.added.length > 0) console.log(`[scheduler]   Added: ${result.added.join(", ")}`);
        if (result.updated.length > 0) console.log(`[scheduler]   Updated: ${result.updated.join(", ")}`);
        if (result.removed.length > 0) console.log(`[scheduler]   Removed: ${result.removed.join(", ")}`);
      }
      if (result.errors.length > 0) {
        console.error(`[scheduler] Errors:`, result.errors);
      }
    } catch (err) {
      console.error(`[scheduler] Sync failed:`, err);
    }
  }, 1000);
}

export function startCronSync(): { stop: () => void } {
  fs.mkdirSync(SCHEDULES_DIR, { recursive: true });

  console.log(`[scheduler] Watching ${SCHEDULES_DIR}`);
  onScheduleChange();

  try {
    watcher = fs.watch(SCHEDULES_DIR, { persistent: false }, (_event, filename) => {
      if (filename && filename.endsWith(".json")) {
        onScheduleChange();
      }
    });
  } catch (err) {
    console.error(`[scheduler] Failed to watch directory:`, err);
  }

  return {
    stop() {
      if (debounceTimer) clearTimeout(debounceTimer);
      if (watcher) {
        watcher.close();
        watcher = null;
      }
    },
  };
}
