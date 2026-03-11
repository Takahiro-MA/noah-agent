export type ScheduleDefinition = {
  /** Job ID. Defaults to filename (without .json) */
  id?: string;
  name: string;
  description?: string;
  enabled?: boolean;
  schedule:
    | { kind: "at"; at: string }
    | { kind: "every"; everyMs: number; anchorMs?: number }
    | { kind: "cron"; expr: string; tz?: string };
  payload:
    | { kind: "systemEvent"; text: string }
    | {
        kind: "agentTurn";
        message: string;
        model?: string;
        timeoutSeconds?: number;
      };
  precondition?: { kind: "fileExists"; path: string };
  deleteAfterRun?: boolean;
};

export type JobState = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  schedule: ScheduleDefinition["schedule"];
  payload: ScheduleDefinition["payload"];
  precondition?: ScheduleDefinition["precondition"];
  deleteAfterRun: boolean;
  lastRunAtMs?: number;
  lastError?: string;
  runCount: number;
  createdAtMs: number;
};

export type JobStoreFile = {
  version: number;
  jobs: Record<string, JobState>;
};
