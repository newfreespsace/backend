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
}

export interface RemotePage {
  submissions: RemoteSubmission[];
  cursor: string;
  scan: RemoteAccountEntity["scan"];
  more: boolean;
  pending: boolean;
  acknowledge?: () => Promise<void>;
}

@Injectable()
export class RemoteProviderService {
  constructor(
    private readonly redisService: RedisService,
    private readonly lockService: LockService,
    @Inject(forwardRef(() => SiteSettingService)) private readonly siteSettingService: SiteSettingService
  ) {}

  // Shared Redis limits cover sync workers and binding requests across all backend processes.
  async hasAtcoderDirectSession(): Promise<boolean> {
    return !!(await this.siteSettingService.getAtcoderSession());
  }

  private async request(platform: SubmissionMethod, url: string, authenticated = false): Promise<string> {
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
    return await this.lockService
      .lock(`RemoteProvider_${platform}`, async () => {
        const redis = this.redisService.getClient();
        const key = `remote-provider-rate:${platform}`;
        const wait = await redis.pttl(key);
        if (wait > 0) await delay(wait);
        await redis.set(key, "1", "PX", platform === SubmissionMethod.Codeforces ? 2200 : 1500);
        const response = await fetch(url, {
          redirect: "manual",
          signal: AbortSignal.timeout(20000),
          headers
        });
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
        const text = await response.text();
        if (text.length > 8 * 1024 * 1024) throw new Error("REMOTE_RESPONSE_TOO_LARGE");
        return text;
      })
      .catch(error => {
        throw new Error(/^REMOTE_[A-Z_]+$/.test(error.message) ? error.message : "REMOTE_UNAVAILABLE");
      });
  }

  private async codeforces<T>(method: string, params: Record<string, string>): Promise<T[]> {
    let response;
    try {
      response = JSON.parse(
        await this.request(
          SubmissionMethod.Codeforces,
          `https://codeforces.com/api/${method}?${new URLSearchParams(params)}`
        )
      );
    } catch (error) {
      throw new Error(/^REMOTE_[A-Z_]+$/.test(error.message) ? error.message : "REMOTE_API_FAILED");
    }
    if (response.status !== "OK" || !Array.isArray(response.result)) throw new Error("REMOTE_API_FAILED");
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
    const redis = this.redisService.getClient();
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
    const scan = account.scan || { offset: 1, head: 0 };
    const rows = await this.codeforces<CodeforcesSubmissionRow>("user.status", {
      handle: account.handle,
      from: String(scan.offset),
      count: "100"
    });
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
        url: `https://codeforces.com/contest/${row.problem.contestId}/submission/${row.id}`
      }));
    const head = Math.max(scan.head, ...rows.map(row => Number(row.id)), 0);
    const pendingIds = submissions.filter(row => row.status === SubmissionStatus.Pending).map(row => Number(row.id));
    const pendingMin = Math.min(scan.pendingMin || Infinity, ...pendingIds);
    const more = rows.length === 100 && Number(rows[rows.length - 1].id) > Number(account.cursor);
    return {
      submissions,
      more,
      pending: Number.isFinite(pendingMin),
      cursor: more ? account.cursor : String(Number.isFinite(pendingMin) ? Math.min(head, pendingMin - 1) : head),
      scan: more
        ? { offset: scan.offset + rows.length, head, pendingMin: Number.isFinite(pendingMin) ? pendingMin : undefined }
        : null
    };
  }
}
