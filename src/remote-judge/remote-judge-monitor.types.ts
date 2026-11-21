import { SubmissionMethod } from "./remote-judge.types";
import { RemoteErrorDetails } from "./remote-error";

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

interface RemoteMonitorTaskAccount {
  accountId: number;
  userId: number;
  username: string;
  handle: string;
}

export interface RemoteMonitorWaitingTask {
  account: RemoteMonitorTaskAccount;
  status: "Queued" | "RetryQueued" | "RetryWaiting" | "Scheduled";
  nextSyncAt: string;
}

export interface RemoteMonitorPublicTask {
  id: string;
  status: "Running" | RemoteMonitorWaitingTask["status"];
  time: string;
  phase?: RemoteTaskPhase;
}

export interface RemoteMonitorAccount extends RemoteMonitorTaskAccount {
  lastError: string | null;
  lastErrorAt: string | null;
  nextSyncAt: string | null;
  sourceError: string | null;
  sourceErrorAt: string | null;
  sourceRetryAt: string | null;
  lastErrorDetails?: RemoteErrorDetails;
  sourceErrorDetails?: RemoteErrorDetails;
}

export interface RemoteMonitorError {
  id: string;
  account: RemoteMonitorTaskAccount;
  kind: "Result" | "Source";
  error: string;
  at: string;
  retryAt: string | null;
  details: RemoteErrorDetails;
}

export interface RemotePlatformMonitor {
  platform: SubmissionMethod;
  state: RemoteMonitorState;
  lastSyncedAt: string | null;
  lastHeartbeatAt: string | null;
  sourceSupport: "PersonalKey" | "PersonalSession" | "Unavailable";
  taskStatuses?: RemoteMonitorPublicTask[];
  admin?: {
    boundAccounts: number;
    activeAccounts: number;
    queuedAccounts: number;
    retryingAccounts: number;
    historyAccounts: number;
    pendingSubmissions: number;
    sourcePendingSubmissions: number;
    sourceFailedSubmissions: number;
    errorAccounts: number;
    sourceErrorAccounts: number;
    oldestQueuedAt: string | null;
    liveWorkers: number;
    tasks: { account: RemoteMonitorAccount; phase: RemoteTaskPhase; startedAt: string }[];
    waitingTasks: RemoteMonitorWaitingTask[];
    errors: RemoteMonitorAccount[];
    errorsTruncated: boolean;
    recentErrors: RemoteMonitorError[];
    errorHistoryAvailable: boolean;
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
