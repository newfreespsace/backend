import { createHash, randomBytes } from "crypto";

import { Injectable } from "@nestjs/common";

import * as cheerio from "cheerio";

import { RedisService } from "@/redis/redis.service";
import { LockService } from "@/redis/lock.service";
import { delay } from "@/common/delay";

import { logger } from "@/logger";

import { SubmissionStatus } from "@/submission/submission-status.enum";

import { AtcoderSessionService } from "./atcoder-session.service";
import { AtcoderStatusUpdate, parseAtcoderStatusResponse } from "./atcoder-status.parser";

import { RemoteAccountEntity } from "./remote-account.entity";
import { RemoteSubmission, remoteVerdict, SubmissionMethod } from "./remote-judge.types";
import { parseAtcoderSubmissionDetail } from "./atcoder-detail.parser";
import { MAX_REMOTE_SOURCE_BYTES } from "./remote-source";
import { assertAtcoderPage, ATCODER_USER_AGENT } from "./atcoder-request";
import { safeAtcoderRequest } from "./atcoder-request-profile";
import { CODEFORCES_USER_AGENT, safeCodeforcesRequest } from "./codeforces-request-profile";
import { AtcoderSourceIdentity, parseAtcoderSource } from "./atcoder-source.parser";
import { CodeforcesCredentials, CodeforcesCredentialsService } from "./codeforces-credentials.service";
import { RemoteErrorDetails, RemoteSyncError, safeRemoteErrorDetails } from "./remote-error";
import { CODEFORCES_COOLDOWN_KEY, CODEFORCES_FAILURES_KEY, CODEFORCES_REQUEST_INTERVAL_MS } from "./codeforces-policy";

const CODEFORCES_RESULT_PAGE_SIZE = 100;
const CODEFORCES_SOURCE_PAGE_SIZE = 20;
const NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENOTFOUND",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID"
]);
class RemoteRequestError extends RemoteSyncError {}

export interface AtcoderLiveTarget {
  contestId: string;
  since: number;
}

/** Internal credentials scoped to one worker turn; never persist or return them through an API. */
export interface AtcoderSessionContext {
  readonly accountId: number;
  readonly session?: string;
  readonly cooldownMs: number;
}

interface AtcoderLiveScan {
  page: number;
  head: number;
  boundary: number;
  pendingIds: string[];
  pendingRows?: RemoteSubmission[];
  knownRows?: RemoteSubmission[];
  nextDiscoveryAt?: number;
  metadataRetryAt?: number;
  statusRetryAt?: number;
  discoveries?: Record<string, { update?: AtcoderStatusUpdate; failures?: number; retryAt?: number }>;
  detailsFetched?: string[];
}

interface CodeforcesSubmissionRow {
  id: number;
  creationTimeSeconds: number;
  problem: { contestId: number; index: string };
  author: { members: { handle: string }[] };
  verdict?: string;
  programmingLanguage: string;
  timeConsumedMillis?: number;
  memoryConsumedBytes?: number;
  points?: number;
  passedTestCount?: number;
  testset?: string;
  source?: string;
  sourceCode?: string;
  sourceBase64?: string;
}

function decodeCodeforcesSource(row: CodeforcesSubmissionRow): string | undefined {
  if (typeof row.sourceBase64 !== "string")
    return typeof row.source === "string"
      ? row.source
      : typeof row.sourceCode === "string"
      ? row.sourceCode
      : undefined;
  const encoded = row.sourceBase64;
  const maximumBytes = MAX_REMOTE_SOURCE_BYTES;
  if (encoded.length > Math.ceil(maximumBytes / 3) * 4) throw new Error("REMOTE_CF_SOURCE_TOO_LARGE");
  // Buffer.from(base64) accepts malformed input silently; reject it before storing code.
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error("REMOTE_CF_SOURCE_INVALID");
  const bytes = Buffer.from(encoded, "base64");
  const canonical = bytes.toString("base64");
  if (encoded !== canonical && encoded !== canonical.replace(/=+$/, "")) throw new Error("REMOTE_CF_SOURCE_INVALID");
  if (bytes.length > maximumBytes) throw new Error("REMOTE_CF_SOURCE_TOO_LARGE");
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error("REMOTE_CF_SOURCE_INVALID");
  }
}

export interface RemotePage {
  submissions: RemoteSubmission[];
  cursor: string;
  scan: RemoteAccountEntity["scan"];
  more: boolean;
  pending: boolean;
  acknowledge?: () => Promise<void>;
  pollAfterMs?: number;
  warning?: { error: string; details: RemoteErrorDetails };
  sourceError?: string;
  sourceErrorDetails?: RemoteErrorDetails;
  sourceRetryAt?: Date;
}

@Injectable()
export class RemoteProviderService {
  constructor(
    private readonly redisService: RedisService,
    private readonly lockService: LockService,
    private readonly atcoderSessions: AtcoderSessionService,
    private readonly codeforcesCredentials: CodeforcesCredentialsService
  ) {}

  private atcoderCooldownKey(session: string): string {
    return `remote-atcoder-cooldown:${createHash("sha256").update(session).digest("hex")}`;
  }

  async getCodeforcesCooldownMs(): Promise<number> {
    return Math.max(0, await this.redisService.getSharedClient().pttl(CODEFORCES_COOLDOWN_KEY));
  }

  // Load once per worker turn. Requests still recheck shared cooldowns under the rate-limit lock.
  async getAtcoderSessionContext(accountId: number): Promise<AtcoderSessionContext> {
    const session = await this.atcoderSessions.get(accountId);
    const cooldownMs = session
      ? Math.max(0, await this.redisService.getSharedClient().pttl(this.atcoderCooldownKey(session)))
      : 0;
    return { accountId, session, cooldownMs };
  }

  private async requireAtcoderSession(accountId: number, context?: AtcoderSessionContext): Promise<string> {
    if (context && context.accountId !== accountId) throw new Error("REMOTE_AUTH_REQUIRED");
    const session = context ? context.session : await this.atcoderSessions.get(accountId);
    if (!session) throw new Error("REMOTE_AUTH_REQUIRED");
    return session;
  }

  private async request(
    platform: SubmissionMethod,
    url: string,
    authenticated?: boolean,
    credentials?: CodeforcesCredentials,
    accountId?: number,
    suppliedSession?: string
  ): Promise<string> {
    const headers: Record<string, string> = {
      "User-Agent": platform === SubmissionMethod.AtCoder ? ATCODER_USER_AGENT : CODEFORCES_USER_AGENT,
      Accept:
        platform === SubmissionMethod.AtCoder
          ? new URL(url).pathname.endsWith("/status/json")
            ? "application/json"
            : "text/html"
          : "application/json,text/html"
    };
    let session: string;
    if (authenticated) {
      session = suppliedSession;
      if (!session || /[;\s]/.test(session)) throw new Error("REMOTE_AUTH_REQUIRED");
      if (platform !== SubmissionMethod.AtCoder || new URL(url).origin !== "https://atcoder.jp")
        throw new Error("REMOTE_AUTH_REQUIRED");
      headers.Cookie = `REVEL_SESSION=${session}`;
    }
    if (platform === SubmissionMethod.AtCoder && new URL(url).origin !== "https://atcoder.jp")
      throw new Error("REMOTE_UNAVAILABLE");
    const startedAt = Date.now();
    let stage: "lock" | "rate_limit" | "request" | "body" | "unlock" = "lock";
    let lockWaitMs: number;
    let rateWaitMs = 0;
    let httpStatus: number;
    return await this.lockService
      .lock(`RemoteProvider_${platform}`, async () => {
        lockWaitMs = Date.now() - startedAt;
        stage = "rate_limit";
        const redis = this.redisService.getSharedClient();
        const isCodeforces = platform === SubmissionMethod.Codeforces;
        const cooldownKey = isCodeforces ? CODEFORCES_COOLDOWN_KEY : session ? this.atcoderCooldownKey(session) : null;
        if (cooldownKey && (await redis.pttl(cooldownKey)) > 0)
          throw new RemoteSyncError("REMOTE_COOLDOWN", { stage, reason: "SHARED_COOLDOWN" });
        let retryAfterMs = 0;
        try {
          const key = `remote-provider-rate:${platform}`;
          const wait = await redis.pttl(key);
          if (wait > 0) {
            rateWaitMs = wait;
            await delay(wait);
          }
          await redis.set(key, "1", "PX", isCodeforces ? CODEFORCES_REQUEST_INTERVAL_MS : 1500);
          let address = url;
          if (credentials) {
            const target = new URL(url);
            if (
              platform !== SubmissionMethod.Codeforces ||
              target.origin !== "https://codeforces.com" ||
              target.pathname !== "/api/user.status"
            )
              throw new Error("REMOTE_CF_AUTH_FAILED");
            target.searchParams.set("apiKey", credentials.apiKey);
            target.searchParams.set("time", String(Math.floor(Date.now() / 1000)));
            target.searchParams.sort();
            const prefix = randomBytes(3).toString("hex");
            const signature = createHash("sha512")
              .update(`${prefix}/user.status?${target.searchParams}#${credentials.apiSecret}`)
              .digest("hex");
            target.searchParams.set("apiSig", prefix + signature);
            address = target.toString();
          }
          stage = "request";
          const response = await fetch(address, {
            redirect: "manual",
            signal: AbortSignal.timeout(20000),
            headers
          });
          httpStatus = response.status;
          const retryAfter = response.headers.get("retry-after");
          if (retryAfter) {
            const seconds = /^\d+$/.test(retryAfter)
              ? Number(retryAfter)
              : (Date.parse(retryAfter) - Date.now()) / 1000;
            if (Number.isFinite(seconds))
              retryAfterMs = Math.min(isCodeforces ? 86400000 : 300000, Math.max(0, seconds * 1000));
          }
          if (response.headers.get("cf-mitigated") === "challenge") {
            await response.body?.cancel().catch(() => undefined);
            throw new RemoteSyncError("REMOTE_VERIFICATION_REQUIRED", { stage, reason: "CHALLENGE_PAGE" });
          }
          if (authenticated && response.status >= 300 && response.status < 400) {
            const location = new URL(response.headers.get("location") || "/", url);
            if (location.origin === "https://atcoder.jp" && location.pathname === "/login")
              throw new Error("REMOTE_AUTH_REQUIRED");
          }
          // CF also uses HTTP 400 for structured API failures (including call limits).
          if (!response.ok && !(isCodeforces && response.status === 400)) {
            await response.body?.cancel().catch(() => undefined);
            throw new Error(
              response.status === 429
                ? "REMOTE_RATE_LIMITED"
                : response.status === 403
                ? "REMOTE_ACCESS_DENIED"
                : "REMOTE_UNAVAILABLE"
            );
          }
          stage = "body";
          const text = await response.text();
          if (text.length > 8 * 1024 * 1024) throw new Error("REMOTE_RESPONSE_TOO_LARGE");
          if (isCodeforces) {
            if (/^\s*</.test(text))
              throw new RemoteSyncError("REMOTE_VERIFICATION_REQUIRED", { stage, reason: "CHALLENGE_PAGE" });
            // Inspect failures before releasing the lock: queued callers must see the cooldown.
            let body: { status?: string; comment?: string; result?: unknown };
            try {
              body = JSON.parse(text);
            } catch {
              throw new Error("REMOTE_API_FAILED");
            }
            if (body?.status === "FAILED" && body.comment === "Call limit exceeded")
              throw new Error("REMOTE_RATE_LIMITED");
            if (body?.status === "OK" && Array.isArray(body.result)) await redis.del(CODEFORCES_FAILURES_KEY);
          }
          if (authenticated && !new URL(url).pathname.endsWith("/status/json")) assertAtcoderPage(cheerio.load(text));
          else if (authenticated && /^\s*</.test(text)) assertAtcoderPage(cheerio.load(text));
          stage = "unlock";
          return text;
        } catch (error) {
          // Set shared pauses before unlocking so queued requests cannot follow a rejection.
          if (
            isCodeforces &&
            ["REMOTE_VERIFICATION_REQUIRED", "REMOTE_ACCESS_DENIED", "REMOTE_RATE_LIMITED"].includes(error.message)
          ) {
            const failures = await redis.incr(CODEFORCES_FAILURES_KEY);
            await redis.pexpire(CODEFORCES_FAILURES_KEY, 86400000);
            const baseMs = error.message === "REMOTE_RATE_LIMITED" ? 300000 : 900000;
            const cooldownMs = Math.max(retryAfterMs, Math.min(3600000, baseMs * 2 ** Math.min(failures - 1, 4)));
            await redis.set(CODEFORCES_COOLDOWN_KEY, error.message, "PX", cooldownMs);
          } else if (
            // AtCoder pauses only the affected session; a source-only 403 does not pause everyone.
            cooldownKey &&
            ["REMOTE_AUTH_REQUIRED", "REMOTE_VERIFICATION_REQUIRED", "REMOTE_RATE_LIMITED"].includes(error.message)
          )
            await redis.set(cooldownKey, "1", "PX", Math.max(60000, retryAfterMs), "NX");
          throw error;
        }
      })
      .catch(error => {
        const code = /^REMOTE_[A-Z_]+$/.test(error?.message) ? error.message : "REMOTE_UNAVAILABLE";
        const originalCode = error?.cause?.code || error?.code;
        const networkCode = NETWORK_ERROR_CODES.has(originalCode) ? originalCode : undefined;
        const timedOut =
          error?.name === "TimeoutError" || networkCode === "ETIMEDOUT" || networkCode?.endsWith("_TIMEOUT");
        const reason =
          safeRemoteErrorDetails(error.details).reason ||
          (code !== "REMOTE_UNAVAILABLE"
            ? code
            : stage === "lock" || stage === "unlock"
            ? "LOCK_FAILED"
            : stage === "rate_limit"
            ? "RATE_LIMIT_STORE_FAILED"
            : timedOut
            ? "TIMEOUT"
            : httpStatus >= 300 && httpStatus < 400
            ? "REDIRECT"
            : httpStatus >= 400
            ? "HTTP_ERROR"
            : "NETWORK_ERROR");
        // Only fixed fields and allowlisted codes: never log signed URLs, headers, bodies or raw errors.
        logger.warn(
          `Remote request failed: ${JSON.stringify({
            platform,
            accountId: Number.isSafeInteger(accountId) ? accountId : undefined,
            sourceRequest: !!credentials,
            code,
            reason,
            stage,
            httpStatus,
            networkCode,
            lockWaitMs: lockWaitMs ?? Date.now() - startedAt,
            rateWaitMs,
            durationMs: Date.now() - startedAt
          })}`
        );
        throw new RemoteRequestError(code, {
          stage,
          reason,
          httpStatus,
          ...(platform === SubmissionMethod.Codeforces ? { request: safeCodeforcesRequest(url) } : {})
        });
      });
  }

  private async codeforces<T>(
    method: string,
    params: Record<string, string>,
    credentials?: CodeforcesCredentials,
    accountId?: number
  ): Promise<T[]> {
    const url = `https://codeforces.com/api/${method}?${new URLSearchParams(params)}`;
    try {
      const response = JSON.parse(await this.request(SubmissionMethod.Codeforces, url, false, credentials, accountId));
      if (response?.status !== "OK" || !Array.isArray(response.result))
        throw new Error(
          response?.comment === "Call limit exceeded"
            ? "REMOTE_RATE_LIMITED"
            : credentials
            ? "REMOTE_CF_AUTH_FAILED"
            : "REMOTE_API_FAILED"
        );
      return response.result;
    } catch (error) {
      if (error instanceof RemoteRequestError) throw error;
      throw new RemoteSyncError(/^REMOTE_[A-Z_]+$/.test(error.message) ? error.message : "REMOTE_API_FAILED", {
        stage: "body",
        request: safeCodeforcesRequest(url)
      });
    }
  }

  async verifyProfile(platform: SubmissionMethod, handle: string, code: string): Promise<boolean> {
    if (platform === SubmissionMethod.Codeforces) {
      const users = await this.codeforces<{ handle: string; organization?: string }>("user.info", { handles: handle });
      return (
        users.length === 1 &&
        users[0].handle.toLowerCase() === handle.toLowerCase() &&
        users[0].organization?.trim() === code
      );
    }
    throw new Error("REMOTE_ATCODER_SESSION_REQUIRED");
  }

  async getPage(
    account: RemoteAccountEntity,
    liveTargets?: AtcoderLiveTarget[],
    context?: AtcoderSessionContext
  ): Promise<RemotePage> {
    if (account.platform === SubmissionMethod.Codeforces) return await this.codeforcesPage(account);
    const session = await this.requireAtcoderSession(account.id, context);
    const live = liveTargets?.length
      ? await this.atcoderLivePage(account, liveTargets, session)
      : { submissions: [], pending: false, pollAfterMs: undefined, acknowledge: undefined, warning: undefined };
    return {
      submissions: [...new Map(live.submissions.map(row => [row.id, row])).values()].sort(
        (a, b) => a.submittedAt - b.submittedAt || Number(a.id) - Number(b.id)
      ),
      cursor: account.cursor,
      scan: null,
      more: false,
      pending: live.pending,
      pollAfterMs: live.pollAfterMs,
      acknowledge: live.acknowledge,
      warning: live.warning
    };
  }

  async identifyAtcoderSession(session: string, accountId?: number): Promise<string> {
    const html = await this.request(
      SubmissionMethod.AtCoder,
      "https://atcoder.jp/settings",
      true,
      undefined,
      accountId,
      session
    );
    const $ = cheerio.load(html);
    const match = html.match(/(?:var|let|const)\s+userScreenName\s*=\s*("(?:[^"\\]|\\.)*")\s*;/);
    let handle: string;
    try {
      handle = match ? JSON.parse(match[1]) : "";
    } catch {
      throw new Error("REMOTE_SESSION_IDENTITY_MISMATCH");
    }
    const logout = $("a[href], form[action]")
      .toArray()
      .some(element => {
        try {
          const target = new URL($(element).attr("href") || $(element).attr("action"), "https://atcoder.jp");
          return target.origin === "https://atcoder.jp" && target.pathname === "/logout";
        } catch {
          return false;
        }
      });
    if (typeof handle !== "string" || !/^[a-zA-Z0-9_.-]{3,64}$/.test(handle) || !logout)
      throw new Error("REMOTE_AUTH_REQUIRED");
    return handle;
  }

  async getAtcoderSource(
    expected: AtcoderSourceIdentity,
    accountId: number,
    context?: AtcoderSessionContext
  ): Promise<string> {
    if (
      !/^[1-9]\d*$/.test(expected.id) ||
      !Number.isSafeInteger(Number(expected.id)) ||
      !/^[\w-]+$/.test(expected.contestId) ||
      !/^[\w-]+$/.test(expected.taskId) ||
      !/^[a-zA-Z0-9_.-]{1,64}$/.test(expected.handle)
    )
      throw new Error("REMOTE_SOURCE_IDENTITY_MISMATCH");
    const session = await this.requireAtcoderSession(accountId, context);
    const html = await this.request(
      SubmissionMethod.AtCoder,
      `https://atcoder.jp/contests/${expected.contestId}/submissions/${expected.id}`,
      true,
      undefined,
      accountId,
      session
    );
    return parseAtcoderSource(html, expected);
  }

  private async atcoderLivePage(account: RemoteAccountEntity, targets: AtcoderLiveTarget[], session: string) {
    const redis = this.redisService.getSharedClient();
    const ordered = [...targets].sort((a, b) => a.contestId.localeCompare(b.contestId));
    const rotationKey = `remote-atcoder-rotation:${account.id}`;
    const index = (Number(await redis.get(rotationKey)) || 0) % ordered.length;
    const target = ordered[index];
    await redis.set(rotationKey, String(index + 1), "EX", 86400);
    const key = `remote-atcoder-pages:${account.id}:${target.contestId}`;
    const saved = await redis.get(key);
    const scan: AtcoderLiveScan = saved ? JSON.parse(saved) : { page: 2, head: 0, boundary: 0, pendingIds: [] };
    const known = new Map([...(scan.knownRows || []), ...(scan.pendingRows || [])].map(row => [row.id, row]));
    const fetched = new Set(scan.detailsFetched || []);
    const discoveries = new Map(Object.entries(scan.discoveries || {}));
    for (const id of scan.pendingIds) if (!discoveries.has(id)) discoveries.set(id, {});
    const rows = new Map<string, RemoteSubmission>();
    const statusUrl = `https://atcoder.jp/contests/${encodeURIComponent(target.contestId)}/submissions/me/status/json`;
    let updates: AtcoderStatusUpdate[];
    try {
      updates = parseAtcoderStatusResponse(
        await this.request(SubmissionMethod.AtCoder, statusUrl, true, undefined, account.id, session)
      );
    } catch (error) {
      const details = safeRemoteErrorDetails(error.details);
      error.details = {
        ...details,
        ...(details.stage === "parse" ? { httpStatus: 200 } : {}),
        contestId: target.contestId,
        request: safeAtcoderRequest(statusUrl)
      };
      // Never fall back to a list. Authentication and network errors retain worker backoff.
      throw error;
    }
    for (const update of updates) {
      const previous = known.get(update.id);
      if (previous) {
        const row = { ...previous, ...update };
        known.set(update.id, row);
        rows.set(update.id, row);
      }
      if (
        discoveries.has(update.id) ||
        (previous && !fetched.has(update.id) && !previous.sourceAvailable) ||
        (!previous && (Number(update.id) > scan.boundary || update.status === SubmissionStatus.Pending))
      )
        discoveries.set(update.id, { ...discoveries.get(update.id), update });
    }
    let warning: RemotePage["warning"];
    // Bound upstream work per turn. Every pending ID is still polled through JSON together.
    const due = [...discoveries.entries()]
      .filter(
        ([, item]) => item.update && item.update.status !== SubmissionStatus.Pending && !(item.retryAt > Date.now())
      )
      .sort((a, b) => (a[1].failures || 0) - (b[1].failures || 0) || Number(a[0]) - Number(b[0]))
      .slice(0, 5);
    for (const [id, item] of due) {
      const url = `https://atcoder.jp/contests/${encodeURIComponent(target.contestId)}/submissions/${id}`;
      try {
        const detail = parseAtcoderSubmissionDetail(
          // eslint-disable-next-line no-await-in-loop -- Keep this bounded batch under the shared limiter.
          await this.request(SubmissionMethod.AtCoder, url, true, undefined, account.id, session),
          { id, contestId: target.contestId, handle: account.handle }
        );
        const row: RemoteSubmission = { ...detail, ...item.update, resultSource: "OriginalSite" };
        rows.set(id, row);
        const { sourceCode, ...cached } = row;
        known.set(id, { ...cached, ...(sourceCode !== undefined ? { sourceAvailable: true } : {}) });
        fetched.add(id);
        discoveries.delete(id);
        scan.boundary = Math.max(scan.boundary, Number(id));
      } catch (error) {
        const safe = safeRemoteErrorDetails(error.details);
        const details = {
          ...safe,
          ...(safe.stage === "parse" ? { httpStatus: 200 } : {}),
          contestId: target.contestId,
          submissionId: id,
          request: safeAtcoderRequest(url)
        };
        error.details = details;
        if (
          [
            "REMOTE_AUTH_REQUIRED",
            "REMOTE_SESSION_UNREADABLE",
            "REMOTE_COOLDOWN",
            "REMOTE_RATE_LIMITED",
            "REMOTE_VERIFICATION_REQUIRED"
          ].includes(error.message)
        )
          throw error;
        const failures = Math.min((item.failures || 0) + 1, 30);
        discoveries.set(id, {
          ...item,
          failures,
          retryAt: Date.now() + Math.min(3600000, 60000 * 2 ** Math.min(failures - 1, 6))
        });
        warning = { error: /^REMOTE_[A-Z_]+$/.test(error.message) ? error.message : "REMOTE_PARSE_FAILED", details };
      }
    }
    scan.discoveries = Object.fromEntries(discoveries);
    scan.pendingRows = [...known.values()].filter(row => row.status === SubmissionStatus.Pending);
    scan.pendingIds = [...new Set([...scan.pendingRows.map(row => row.id), ...discoveries.keys()])];
    scan.knownRows = [...known.values()].sort((a, b) => Number(b.id) - Number(a.id)).slice(0, 200);
    scan.detailsFetched = scan.knownRows.filter(row => fetched.has(row.id)).map(row => row.id);
    // Discard the obsolete list pagination and retry state on migration.
    scan.page = 2;
    scan.head = 0;
    delete scan.nextDiscoveryAt;
    delete scan.metadataRetryAt;
    delete scan.statusRetryAt;
    const pendingKey = `remote-atcoder-pending:${account.id}`;
    const pendingContests = new Set<string>(JSON.parse((await redis.get(pendingKey)) || "[]"));
    for (const contestId of pendingContests)
      if (!ordered.some(item => item.contestId === contestId)) pendingContests.delete(contestId);
    if (scan.pendingIds.length) pendingContests.add(target.contestId);
    else pendingContests.delete(target.contestId);
    return {
      submissions: [...rows.values()],
      pending: pendingContests.size > 0,
      pollAfterMs: pendingContests.size > 0 ? 5000 : undefined,
      warning,
      // Persist only after imports succeed; never cache source code in Redis.
      acknowledge: async () => {
        await redis.set(key, JSON.stringify(scan), "EX", 86400);
        await redis.set(pendingKey, JSON.stringify([...pendingContests]), "EX", 86400);
      }
    };
  }

  private async codeforcesPage(account: RemoteAccountEntity): Promise<RemotePage> {
    const scan = account.scan || { offset: 1, head: 0 };
    const { cursor } = account;
    const params = {
      handle: account.handle,
      from: String(scan.offset),
      count: String(CODEFORCES_RESULT_PAGE_SIZE)
    };
    let pageSize = CODEFORCES_RESULT_PAGE_SIZE;
    let rows: CodeforcesSubmissionRow[];
    let sourceError: string;
    let sourceErrorDetails: RemoteErrorDetails;
    let sourceRetryAt: Date;
    let sourceAuthorized = false;
    const sources = new Map<CodeforcesSubmissionRow, string>();
    if (
      account.codeforcesSourceEnabled &&
      (!account.codeforcesSourceRetryAt || account.codeforcesSourceRetryAt <= new Date())
    ) {
      let sourceRequest: RemoteErrorDetails["request"];
      try {
        const credentials = await this.codeforcesCredentials.get(account.id);
        if (!credentials) throw new Error("REMOTE_CF_CREDENTIALS_UNREADABLE");
        const sourceParams = { ...params, count: String(CODEFORCES_SOURCE_PAGE_SIZE), includeSources: "true" };
        sourceRequest = safeCodeforcesRequest(
          `https://codeforces.com/api/user.status?${new URLSearchParams(sourceParams)}`
        );
        rows = await this.codeforces<CodeforcesSubmissionRow>("user.status", sourceParams, credentials, account.id);
        sourceAuthorized = true;
        pageSize = CODEFORCES_SOURCE_PAGE_SIZE;
        for (const row of rows) {
          const source = decodeCodeforcesSource(row);
          if (source !== undefined) sources.set(row, source);
        }
        if (
          rows.some(
            row =>
              row.author?.members?.some(member => member.handle.toLowerCase() === account.handle.toLowerCase()) &&
              !sources.has(row)
          )
        )
          throw new Error("REMOTE_CF_SOURCE_MISSING");
      } catch (error) {
        // Request failures retain the current checkpoint and back off at the worker level.
        // In particular, never follow a challenge/rate limit with a public fallback request.
        if (
          error instanceof RemoteRequestError ||
          ![
            "REMOTE_CF_AUTH_FAILED",
            "REMOTE_CF_CREDENTIALS_UNREADABLE",
            "REMOTE_CF_SOURCE_MISSING",
            "REMOTE_CF_SOURCE_INVALID",
            "REMOTE_CF_SOURCE_TOO_LARGE"
          ].includes(error.message)
        )
          throw error;
        // A successful source response already contains the results. Keep it even if decoding
        // fails, rather than contacting the public API again for the same page.
        sourceError = /^REMOTE_[A-Z_]+$/.test(error.message) ? error.message : "REMOTE_CF_SOURCE_UNAVAILABLE";
        sourceErrorDetails = safeRemoteErrorDetails({
          ...(sourceRequest ? { stage: "parse", request: sourceRequest } : {}),
          ...safeRemoteErrorDetails(error.details)
        });
        sourceRetryAt = new Date(Date.now() + 300000);
      }
    } else if (account.codeforcesSourceEnabled) {
      sourceError = account.codeforcesSourceError;
      sourceRetryAt = account.codeforcesSourceRetryAt;
    }
    // Public result sync remains available when source authorization fails.
    rows ??= await this.codeforces<CodeforcesSubmissionRow>("user.status", params, undefined, account.id);
    const submissions: RemoteSubmission[] = rows
      .filter(
        row =>
          row.problem?.contestId &&
          row.problem?.index &&
          row.author?.members?.some(member => member.handle.toLowerCase() === account.handle.toLowerCase())
      )
      .map(row => ({
        id: String(row.id),
        contestId: String(row.problem.contestId),
        taskId: row.problem.index,
        submittedAt: row.creationTimeSeconds,
        verdict: row.verdict || "SUBMITTED",
        status: remoteVerdict(account.platform, row.verdict),
        language: row.programmingLanguage,
        time: Number.isFinite(row.timeConsumedMillis) ? row.timeConsumedMillis : null,
        memory: Number.isFinite(row.memoryConsumedBytes) ? row.memoryConsumedBytes : null,
        points: Number.isFinite(row.points) ? row.points : undefined,
        passedTestCount:
          Number.isSafeInteger(row.passedTestCount) && row.passedTestCount >= 0 ? row.passedTestCount : undefined,
        testset: [
          "SAMPLES",
          "PRETESTS",
          "TESTS",
          "CHALLENGES",
          "TESTS1",
          "TESTS2",
          "TESTS3",
          "TESTS4",
          "TESTS5",
          "TESTS6",
          "TESTS7",
          "TESTS8",
          "TESTS9",
          "TESTS10"
        ].includes(row.testset)
          ? row.testset
          : undefined,
        sourceCode: sourceAuthorized ? sources.get(row) : undefined,
        url: `https://codeforces.com/contest/${row.problem.contestId}/submission/${row.id}`
      }));
    const head = Math.max(scan.head, ...rows.map(row => Number(row.id)), 0);
    const pendingIds = submissions.filter(row => row.status === SubmissionStatus.Pending).map(row => Number(row.id));
    const pendingMin = Math.min(scan.pendingMin || Infinity, ...pendingIds);
    const more = rows.length === pageSize && Number(rows[rows.length - 1].id) > Number(cursor);
    return {
      submissions,
      sourceError,
      sourceErrorDetails,
      sourceRetryAt,
      more,
      pending: Number.isFinite(pendingMin),
      cursor: more ? cursor : String(Number.isFinite(pendingMin) ? Math.min(head, pendingMin - 1) : head),
      scan: more
        ? { offset: scan.offset + rows.length, head, pendingMin: Number.isFinite(pendingMin) ? pendingMin : undefined }
        : null
    };
  }
}
