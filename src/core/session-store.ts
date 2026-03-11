import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { BridgeSession } from "./types.js";

type SessionStoreData = {
  sessions: Record<string, BridgeSession>;
};

export class SessionStore {
  private data: SessionStoreData = { sessions: {} };
  private readonly filePath: string;

  constructor(stateDir: string) {
    this.filePath = path.join(stateDir, "bridge-sessions.json");
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf-8");
        this.data = JSON.parse(raw);
      }
    } catch {
      this.data = { sessions: {} };
    }
  }

  private save(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }

  create(callerSessionKey?: string): BridgeSession {
    const sessionId = `noah-${crypto.randomUUID().slice(0, 12)}`;
    const claudeSessionId = crypto.randomUUID();
    const now = Date.now();
    const session: BridgeSession = {
      sessionId,
      claudeSessionId,
      callerSessionKey: callerSessionKey ?? `hook:${sessionId}`,
      createdAt: now,
      lastActivityAt: now,
      status: "active",
      messageCount: 0,
    };
    this.data = {
      sessions: { ...this.data.sessions, [sessionId]: session },
    };
    this.save();
    return session;
  }

  get(sessionId: string): BridgeSession | null {
    return this.data.sessions[sessionId] ?? null;
  }

  touch(sessionId: string): void {
    const session = this.data.sessions[sessionId];
    if (session) {
      this.data = {
        sessions: {
          ...this.data.sessions,
          [sessionId]: {
            ...session,
            lastActivityAt: Date.now(),
            messageCount: session.messageCount + 1,
            status: "active",
          },
        },
      };
      this.save();
    }
  }

  updateClaudeSessionId(sessionId: string, claudeSessionId: string): void {
    const session = this.data.sessions[sessionId];
    if (session) {
      this.data = {
        sessions: {
          ...this.data.sessions,
          [sessionId]: { ...session, claudeSessionId },
        },
      };
      this.save();
    }
  }

  delete(sessionId: string): boolean {
    if (this.data.sessions[sessionId]) {
      const { [sessionId]: _, ...rest } = this.data.sessions;
      this.data = { sessions: rest };
      this.save();
      return true;
    }
    return false;
  }

  list(): BridgeSession[] {
    return Object.values(this.data.sessions);
  }

  cleanup(idleMs: number, expireMs: number, protectedIds?: ReadonlySet<string>): number {
    const now = Date.now();
    let removed = 0;
    const updated: Record<string, BridgeSession> = {};

    for (const [id, session] of Object.entries(this.data.sessions)) {
      // Never expire sessions actively used by Slack threads
      if (protectedIds?.has(id)) {
        updated[id] = session;
        continue;
      }
      const age = now - session.lastActivityAt;
      if (age > expireMs) {
        removed++;
      } else if (age > idleMs && session.status === "active") {
        updated[id] = { ...session, status: "idle" };
      } else {
        updated[id] = session;
      }
    }

    if (removed > 0 || Object.keys(updated).length !== Object.keys(this.data.sessions).length) {
      this.data = { sessions: updated };
      this.save();
    }
    return removed;
  }
}
