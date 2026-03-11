import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Persistent mapping of Slack thread timestamps to Noah session IDs.
 * Survives container restarts by writing to disk on every mutation.
 */
export class ThreadSessionStore {
  private data: Record<string, string> = {};
  private readonly filePath: string;

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, "thread-sessions.json");
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf-8");
        this.data = JSON.parse(raw);
      }
    } catch {
      this.data = {};
    }
  }

  private save(): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf-8");
    fs.renameSync(tmp, this.filePath);
  }

  get(threadTs: string): string | undefined {
    return this.data[threadTs];
  }

  set(threadTs: string, sessionId: string): void {
    this.data = { ...this.data, [threadTs]: sessionId };
    this.save();
  }

  allSessionIds(): ReadonlySet<string> {
    return new Set(Object.values(this.data));
  }

  deleteBySessionId(sessionId: string): void {
    const updated: Record<string, string> = {};
    for (const [ts, sid] of Object.entries(this.data)) {
      if (sid !== sessionId) {
        updated[ts] = sid;
      }
    }
    if (Object.keys(updated).length !== Object.keys(this.data).length) {
      this.data = updated;
      this.save();
    }
  }
}
