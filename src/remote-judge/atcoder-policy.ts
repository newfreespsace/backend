import { RemoteSourceSync } from "./remote-judge.types";

export function scheduleAtcoderSource(previous: RemoteSourceSync | undefined, final: boolean): RemoteSourceSync {
  if (!final || (previous?.readyAt && Date.parse(previous.readyAt) <= Date.now()))
    return previous || { status: "Pending", failures: 0 };
  // Final grades are immediately eligible; upgrade the previous delayed queues as well.
  const readyAt = new Date(Date.now()).toISOString();
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
