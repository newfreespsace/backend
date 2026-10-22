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
  sourceSupport: "PersonalKey" | "SiteSession" | "Unavailable";
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
