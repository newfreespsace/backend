import { SubmissionMethod } from "./remote-judge.types";

export type RemoteMonitorState =
  | "Healthy"
  | "Syncing"
  | "Idle"
  | "RateLimited"
  | "Error"
  | "Disabled"
  | "Unconfigured"
  | "AuthExpired"
  | "Unknown";
export type RemoteTaskPhase = "Syncing" | "Collecting" | "Importing";
export type RemoteTaskContinuation = "None" | "More" | "Pending" | "Polling" | "Retry" | "Paused" | "Inactive";
export interface RemoteTaskProblem {
  problemId: number;
  displayId: number | null;
  title: string;
  remoteKey: string;
  scope: "Round" | "Buffer" | "Watch";
  state: "Watching" | "Collecting" | "Queued" | "Importing" | "Succeeded" | "Skipped" | "Failed";
  records: number | null;
  processed: number;
  synchronized: number;
}

export interface RemoteTaskOutcome {
  state: "Succeeded" | "Failed" | "Skipped";
  continuation: RemoteTaskContinuation;
  processed: number;
  nextSyncAt: string | null;
  error: string | null;
  sourceError: string | null;
}

export interface RemoteFinishedTask extends RemoteTaskOutcome {
  id: string;
  accountId: number;
  phase: RemoteTaskPhase;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  problems: RemoteTaskProblem[];
  problemsTruncated: boolean;
}

export interface RemoteMonitorAccount {
  accountId: number;
  userId: number;
  username: string;
  handle: string;
  lastError: string | null;
  lastErrorAt: string | null;
  nextSyncAt: string | null;
  sourceError: string | null;
  sourceErrorAt: string | null;
  sourceRetryAt: string | null;
}

export interface RemotePlatformMonitor {
  platform: SubmissionMethod;
  state: RemoteMonitorState;
  lastSyncedAt: string | null;
  lastHeartbeatAt: string | null;
  sourceSupport: "PersonalKey" | "Unavailable";
  admin?: {
    boundAccounts: number;
    activeAccounts: number;
    queuedAccounts: number;
    retryingAccounts: number;
    historyAccounts: number;
    pendingSubmissions: number;
    errorAccounts: number;
    sourceErrorAccounts: number;
    oldestQueuedAt: string | null;
    liveWorkers: number;
    tasks: {
      account: RemoteMonitorAccount;
      phase: RemoteTaskPhase;
      startedAt: string;
      problems: RemoteTaskProblem[];
      problemsTruncated: boolean;
    }[];
    scheduledTasks: {
      account: RemoteMonitorAccount;
      phase: RemoteTaskPhase;
      state: "Queued" | "Scheduled" | "Retrying" | "Paused";
      scheduledAt: string | null;
      problems: RemoteTaskProblem[];
      problemsTruncated: boolean;
    }[];
    scheduledTaskTotal: number;
    scheduledTasksTruncated: boolean;
    history: (RemoteFinishedTask & { account: RemoteMonitorAccount | null })[];
    historyAvailable: boolean;
    errors: RemoteMonitorAccount[];
    errorsTruncated: boolean;
    session?: { configured: boolean; status: string; checkedAt: string | null; error: string | null };
  };
}

export interface RemoteJudgeMonitorSnapshot {
  updatedAt: string | null;
  stale: boolean;
  unavailable: boolean;
  platforms: RemotePlatformMonitor[];
  admin?: {
    redis: {
      available: boolean;
      connectedClients: number | null;
      maxClients: number | null;
      rejectedConnections: number | null;
      rejectedDelta: number | null;
      deltaSince: string | null;
      sampledAt: string | null;
    };
  };
}
