import { safeAtcoderRequest } from "./atcoder-request-profile";

// Only structured diagnostics and allowlisted AtCoder requests are retained; never bodies or credentials.
export interface RemoteErrorDetails {
  stage?: string;
  reason?: string;
  contestId?: string;
  page?: number;
  submissionId?: string;
  httpStatus?: number;
  request?: { url: string; command: string };
}

const stages = ["lock", "rate_limit", "request", "body", "unlock", "parse"];
const reasons = [
  "MISSING_SUBMISSION_TABLE",
  "UNEXPECTED_TABLE_HEADERS",
  "LOGIN_PAGE",
  "CHALLENGE_PAGE",
  "SHARED_COOLDOWN",
  "INVALID_STATUS_RESPONSE",
  "INVALID_TASK_LINK",
  "INVALID_SUBMISSION_LINK",
  "INVALID_SUBMISSION_ID",
  "INVALID_SUBMISSION_TIME",
  "MISSING_VERDICT",
  "MISSING_LANGUAGE",
  "LOCK_FAILED",
  "RATE_LIMIT_STORE_FAILED",
  "TIMEOUT",
  "REDIRECT",
  "HTTP_ERROR",
  "NETWORK_ERROR"
];

export function safeRemoteErrorDetails(value: unknown): RemoteErrorDetails {
  const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const details: RemoteErrorDetails = {};
  if (source.request && typeof source.request === "object") {
    const request = safeAtcoderRequest((source.request as Record<string, unknown>).url);
    if (request) details.request = request;
  }
  if (stages.includes(source.stage as string)) details.stage = source.stage as string;
  if (reasons.includes(source.reason as string)) details.reason = source.reason as string;
  if (typeof source.contestId === "string" && /^[\w-]{1,100}$/.test(source.contestId))
    details.contestId = source.contestId;
  if (Number.isSafeInteger(source.page) && Number(source.page) > 0) details.page = Number(source.page);
  if (typeof source.submissionId === "string" && /^[1-9]\d{0,19}$/.test(source.submissionId))
    details.submissionId = source.submissionId;
  if (Number.isInteger(source.httpStatus) && Number(source.httpStatus) >= 100 && Number(source.httpStatus) <= 599)
    details.httpStatus = Number(source.httpStatus);
  return details;
}

export class RemoteSyncError extends Error {
  readonly details: RemoteErrorDetails;

  constructor(code: string, details: RemoteErrorDetails) {
    super(code);
    this.details = safeRemoteErrorDetails(details);
  }
}
