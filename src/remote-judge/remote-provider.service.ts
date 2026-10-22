import { createHash, randomBytes } from "crypto";

import { forwardRef, Inject, Injectable } from "@nestjs/common";

import * as cheerio from "cheerio";

import { RedisService } from "@/redis/redis.service";
import { LockService } from "@/redis/lock.service";
import { delay } from "@/common/delay";
import { SiteSettingService } from "@/site-setting/site-setting.service";
import { logger } from "@/logger";

import { SubmissionStatus } from "@/submission/submission-status.enum";

import { RemoteAccountEntity } from "./remote-account.entity";
import { RemoteSubmission, remoteVerdict, SubmissionMethod } from "./remote-judge.types";
import { parseAtcoderSubmissionPage } from "./atcoder-submission.parser";
import { CodeforcesCredentials, CodeforcesCredentialsService } from "./codeforces-credentials.service";

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
const RETRYABLE_NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET"
]);

class RemoteRequestError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
  }
}

export interface AtcoderLiveTarget {
  contestId: string;
  since: number;
}

interface AtcoderLiveScan {
  page: number;
  head: number;
  boundary: number;
  pendingIds: string[];
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
  const maximumBytes = 1024 * 1024;
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
  sourceError?: string;
  sourceRetryAt?: Date;
}

@Injectable()
export class RemoteProviderService {
  constructor(
    private readonly redisService: RedisService,
    private readonly lockService: LockService,
    @Inject(forwardRef(() => SiteSettingService)) private readonly siteSettingService: SiteSettingService,
    private readonly codeforcesCredentials: CodeforcesCredentialsService
  ) {}

  // Shared Redis limits cover sync workers and binding requests across all backend processes.
  async hasAtcoderDirectSession(): Promise<boolean> {
    return !!(await this.siteSettingService.getAtcoderSession());
  }

  private async request(
    platform: SubmissionMethod,
    url: string,
    authenticated?: boolean,
    credentials?: CodeforcesCredentials,
    accountId?: number
  ): Promise<string> {
    const headers: Record<string, string> = {
      "User-Agent": "NSOJ-Result-Sync/1.0",
      Accept: "application/json,text/html"
    };
    if (authenticated) {
      const session = await this.siteSettingService.getAtcoderSession();
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
        const key = `remote-provider-rate:${platform}`;
        const wait = await redis.pttl(key);
        if (wait > 0) {
          rateWaitMs = wait;
          await delay(wait);
        }
        await redis.set(key, "1", "PX", platform === SubmissionMethod.Codeforces ? 2200 : 1500);
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
        if (authenticated && response.status >= 300 && response.status < 400) {
          const location = new URL(response.headers.get("location") || "/", url);
          if (location.origin === "https://atcoder.jp" && location.pathname === "/login")
            throw new Error("REMOTE_AUTH_REQUIRED");
        }
        if (!response.ok)
          throw new Error(
            response.status === 429
              ? "REMOTE_RATE_LIMITED"
              : response.status === 403
              ? "REMOTE_ACCESS_DENIED"
              : "REMOTE_UNAVAILABLE"
          );
        stage = "body";
        const text = await response.text();
        if (text.length > 8 * 1024 * 1024) throw new Error("REMOTE_RESPONSE_TOO_LARGE");
        stage = "unlock";
        return text;
      })
      .catch(error => {
        const code = /^REMOTE_[A-Z_]+$/.test(error?.message) ? error.message : "REMOTE_UNAVAILABLE";
        const originalCode = error?.cause?.code || error?.code;
        const networkCode = NETWORK_ERROR_CODES.has(originalCode) ? originalCode : undefined;
        const timedOut =
          error?.name === "TimeoutError" || networkCode === "ETIMEDOUT" || networkCode?.endsWith("_TIMEOUT");
        const reason =
          code !== "REMOTE_UNAVAILABLE"
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
            : "NETWORK_ERROR";
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
        const retryable =
          code === "REMOTE_UNAVAILABLE" &&
          (stage === "request" || stage === "body") &&
          (timedOut ||
            RETRYABLE_NETWORK_ERROR_CODES.has(networkCode) ||
            (!httpStatus && !originalCode && error?.name === "TypeError") ||
            [408, 500, 502, 503, 504].includes(httpStatus));
        throw new RemoteRequestError(code, retryable);
      });
  }

  private async codeforces<T>(
    method: string,
    params: Record<string, string>,
    credentials?: CodeforcesCredentials,
    accountId?: number
  ): Promise<T[]> {
    let response;
    try {
      response = JSON.parse(
        await this.request(
          SubmissionMethod.Codeforces,
          `https://codeforces.com/api/${method}?${new URLSearchParams(params)}`,
          false,
          credentials,
          accountId
        )
      );
    } catch (error) {
      if (error instanceof RemoteRequestError) throw error;
      throw new Error(/^REMOTE_[A-Z_]+$/.test(error.message) ? error.message : "REMOTE_API_FAILED");
    }
    if (response?.status !== "OK" || !Array.isArray(response.result))
      throw new Error(
        response?.comment === "Call limit exceeded"
          ? "REMOTE_RATE_LIMITED"
          : credentials
          ? "REMOTE_CF_AUTH_FAILED"
          : "REMOTE_API_FAILED"
      );
    return response.result;
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
    const html = await this.request(
      SubmissionMethod.AtCoder,
      `https://atcoder.jp/users/${encodeURIComponent(handle)}?lang=en`
    );
    const $ = cheerio.load(html);
    return $("tr")
      .toArray()
      .some(row => $(row).find("th").text().trim() === "Affiliation" && $(row).find("td").text().trim() === code);
  }

  async getPage(account: RemoteAccountEntity, liveTargets: AtcoderLiveTarget[] = []): Promise<RemotePage> {
    if (account.platform === SubmissionMethod.Codeforces) return await this.codeforcesPage(account);
    const session = await this.siteSettingService.getAtcoderSession();
    if (!session) throw new Error("REMOTE_AUTH_REQUIRED");
    let live: { submissions: RemoteSubmission[]; pending: boolean; acknowledge?: () => Promise<void> };
    try {
      live = liveTargets.length
        ? await this.atcoderLivePage(account, liveTargets)
        : { submissions: [], pending: false };
    } catch (error) {
      await this.reportAtcoderSessionCheck(session, error.message);
      throw error;
    }
    if (liveTargets.length) await this.reportAtcoderSessionCheck(session);
    return {
      submissions: [...new Map(live.submissions.map(row => [row.id, row])).values()],
      cursor: account.cursor,
      scan: null,
      more: false,
      pending: live.pending,
      acknowledge: live.acknowledge
    };
  }

  private async reportAtcoderSessionCheck(session: string, error?: string): Promise<void> {
    try {
      await this.siteSettingService.recordAtcoderSessionCheck(session, error);
    } catch {
      logger.warn("Unable to save AtCoder session check status");
    }
  }

  private async atcoderLivePage(account: RemoteAccountEntity, targets: AtcoderLiveTarget[]) {
    const redis = this.redisService.getSharedClient();
    const ordered = [...targets].sort((a, b) => a.contestId.localeCompare(b.contestId));
    const rotationKey = `remote-atcoder-rotation:${account.id}`;
    const index = (Number(await redis.get(rotationKey)) || 0) % ordered.length;
    const target = ordered[index];
    await redis.set(rotationKey, String(index + 1), "EX", 86400);
    const key = `remote-atcoder-pages:${account.id}:${target.contestId}`;
    const saved = await redis.get(key);
    const scan: AtcoderLiveScan = saved ? JSON.parse(saved) : { page: 2, head: 0, boundary: 0, pendingIds: [] };
    const readPage = async (page: number) =>
      parseAtcoderSubmissionPage(
        await this.request(
          SubmissionMethod.AtCoder,
          `https://atcoder.jp/contests/${encodeURIComponent(target.contestId)}/submissions?${new URLSearchParams({
            "f.User": account.handle,
            lang: "en",
            page: String(page)
          })}`,
          true
        ),
        target.contestId,
        account.handle,
        page
      );
    const first = await readPage(1);
    const rows = [...first.submissions];
    const pending = new Set(scan.pendingIds);
    const updatePending = (submissions: RemoteSubmission[]) => {
      for (const row of submissions) {
        if (row.status === SubmissionStatus.Pending) pending.add(row.id);
        else pending.delete(row.id);
      }
    };
    updatePending(rows);
    scan.head = Math.max(scan.head, ...rows.map(row => Number(row.id)));
    const needsOlder = (result: typeof first) =>
      result.more &&
      result.submissions.length > 0 &&
      (scan.boundary || pending.size
        ? Math.min(...result.submissions.map(row => Number(row.id))) >
          Math.min(scan.boundary || Infinity, ...[...pending].map(Number))
        : Math.min(...result.submissions.map(row => row.submittedAt)) >= target.since);
    let more = needsOlder(first);
    // Always refresh page one; at most one additional page per turn bounds work
    // without losing bursts of submissions or old pending judgements.
    if (more) {
      const older = await readPage(scan.page);
      rows.push(...older.submissions);
      updatePending(older.submissions);
      more = needsOlder(older);
      scan.page++;
    }
    if (!more) {
      scan.boundary = scan.head;
      scan.head = 0;
      scan.page = 2;
    }
    scan.pendingIds = [...pending];
    const pendingKey = `remote-atcoder-pending:${account.id}`;
    const pendingContests = new Set<string>(JSON.parse((await redis.get(pendingKey)) || "[]"));
    for (const contestId of pendingContests)
      if (!ordered.some(item => item.contestId === contestId)) pendingContests.delete(contestId);
    if (more || pending.size > 0) pendingContests.add(target.contestId);
    else pendingContests.delete(target.contestId);
    return {
      submissions: rows,
      pending: pendingContests.size > 0,
      // Advance only after every imported result has been saved successfully.
      acknowledge: async () => {
        await redis.set(key, JSON.stringify(scan), "EX", 86400);
        await redis.set(pendingKey, JSON.stringify([...pendingContests]), "EX", 86400);
      }
    };
  }

  private async codeforcesPage(account: RemoteAccountEntity): Promise<RemotePage> {
    let scan = account.scan || { offset: 1, head: 0 };
    let { cursor } = account;
    const params = {
      handle: account.handle,
      from: String(scan.offset),
      count: String(CODEFORCES_RESULT_PAGE_SIZE)
    };
    let pageSize = CODEFORCES_RESULT_PAGE_SIZE;
    let rows: CodeforcesSubmissionRow[];
    let sourceError: string;
    let sourceRetryAt: Date;
    let sourceAuthorized = false;
    const sources = new Map<CodeforcesSubmissionRow, string>();
    if (
      account.codeforcesSourceEnabled &&
      (!account.codeforcesSourceRetryAt || account.codeforcesSourceRetryAt <= new Date())
    ) {
      try {
        const credentials = await this.codeforcesCredentials.get(account.id);
        if (!credentials) throw new Error("REMOTE_CF_CREDENTIALS_UNREADABLE");
        const readSources = () =>
          this.codeforces<CodeforcesSubmissionRow>(
            "user.status",
            {
              ...params,
              from: account.codeforcesSourceError ? "1" : params.from,
              count: String(CODEFORCES_SOURCE_PAGE_SIZE),
              includeSources: "true"
            },
            credentials,
            account.id
          );
        try {
          rows = await readSources();
        } catch (error) {
          if (!(error instanceof RemoteRequestError) || !error.retryable) throw error;
          // Re-enter the shared limiter and generate a fresh signature for the single retry.
          logger.warn(`Codeforces source account ${account.id}: retrying transient request failure once`);
          rows = await readSources();
          logger.log(`Codeforces source account ${account.id}: transient request recovered`);
        }
        for (const row of rows) {
          const source = decodeCodeforcesSource(row);
          if (source !== undefined) sources.set(row, source);
        }
        if (rows.length && sources.size === 0) throw new Error("REMOTE_CF_SOURCE_MISSING");
        sourceAuthorized = true;
        pageSize = CODEFORCES_SOURCE_PAGE_SIZE;
        if (account.codeforcesSourceError) {
          // Recovering credentials must revisit pages skipped during public-only result sync.
          scan = { offset: 1, head: 0 };
          cursor = "0";
        }
      } catch (error) {
        rows = undefined;
        sourceError = /^REMOTE_[A-Z_]+$/.test(error.message) ? error.message : "REMOTE_CF_SOURCE_UNAVAILABLE";
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
