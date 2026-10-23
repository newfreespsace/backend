import { RemoteSourceSync } from "./remote-judge.types";

// Wait one minute after the first final grade, independently of the original submission time.
export const ATCODER_SOURCE_DELAY_MS = 60 * 1000;

export function scheduleAtcoderSource(previous: RemoteSourceSync | undefined, final: boolean): RemoteSourceSync {
  if (!final || previous?.readyAt) return previous || { status: "Pending", failures: 0 };
  const readyAt = new Date(Date.now() + ATCODER_SOURCE_DELAY_MS).toISOString();
  return {
    ...previous,
    status: previous?.status || "Pending",
    failures: previous?.failures || 0,
    readyAt,
    // Preserve a failed request's longer backoff when upgrading an older queue entry.
    nextAttemptAt:
      previous?.failures > 0 && Date.parse(previous.nextAttemptAt) > Date.parse(readyAt)
        ? previous.nextAttemptAt
        : readyAt
  };
}
