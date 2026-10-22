/* eslint-disable no-await-in-loop -- Bounded monitoring queries and cache coordination. */
import { randomBytes } from "crypto";

import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";

import { DataSource, Like } from "typeorm";

import { ConfigService } from "@/config/config.service";
import { RedisService } from "@/redis/redis.service";
import { SiteSettingService } from "@/site-setting/site-setting.service";
import { SubmissionEntity } from "@/submission/submission.entity";
import { SubmissionStatus } from "@/submission/submission-status.enum";
import { UserEntity } from "@/user/user.entity";

import { RemoteAccountEntity } from "./remote-account.entity";
import { SubmissionMethod } from "./remote-judge.types";
import {
  RemoteJudgeMonitorSnapshot,
  RemoteMonitorAccount,
  RemoteMonitorError,
  RemoteMonitorState,
  RemotePlatformMonitor,
  RemoteTaskPhase
} from "./remote-judge-monitor.types";
import { safeRemoteErrorDetails } from "./remote-error";

const platforms = [SubmissionMethod.Codeforces, SubmissionMethod.AtCoder];
const CACHE_KEY = "remote-monitor:snapshot:v1";
const CACHE_MS = 10000;
const HEARTBEAT_MS = 45000;
const ERROR_HISTORY_LIMIT = 50;
const ERROR_HISTORY_SECONDS = 7 * 86400;
const WORK = "(account.activeUntil > :now OR account.catchUpRequested = 1)";
const DUE = `${WORK} AND account.nextSyncAt <= :now`;
const HISTORY =
  "account.platform = :cf AND (account.scan IS NOT NULL OR (account.cursor = '0' AND account.catchUpRequested = 1))";

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("MONITOR_TIMEOUT")), 1500);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

interface WorkerState {
  at: string;
  task: { accountId: number; phase: RemoteTaskPhase; startedAt: string } | null;
}

function iso(value: unknown): string | null {
  const date = value ? new Date(value as string) : null;
  return date && Number.isFinite(+date) ? date.toISOString() : null;
}

function safeError(value: unknown): string | null {
  return typeof value === "string" && /^REMOTE_[A-Z_]{1,72}$/.test(value) ? value : value ? "REMOTE_SYNC_FAILED" : null;
}

@Injectable()
export class RemoteJudgeMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly instance = `${process.pid}-${randomBytes(8).toString("hex")}`;

  private readonly tasks = new Map<SubmissionMethod, NonNullable<WorkerState["task"]>>();

  private timer: ReturnType<typeof setInterval>;

  private publishing: Promise<void> = Promise.resolve();

  private collecting: Promise<RemoteJudgeMonitorSnapshot> | null = null;

  private previous: RemoteJudgeMonitorSnapshot | null = null;

  constructor(
    @InjectDataSource() private readonly connection: DataSource,
    private readonly redisService: RedisService,
    private readonly configService: ConfigService,
    private readonly siteSettings: SiteSettingService
  ) {}

  onModuleInit(): void {
    this.publish();
    this.timer = setInterval(() => this.publish(), 10000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  private get enabled(): boolean {
    return this.configService.config.remoteJudge?.enabled ?? true;
  }

  startTask(platform: SubmissionMethod, accountId: number, phase: RemoteTaskPhase): void {
    this.tasks.set(platform, { accountId, phase, startedAt: new Date().toISOString() });
    this.publish();
  }

  setTaskPhase(platform: SubmissionMethod, phase: RemoteTaskPhase): void {
    const task = this.tasks.get(platform);
    if (task && task.phase !== phase) {
      task.phase = phase;
      this.publish();
    }
  }

  finishTask(platform: SubmissionMethod): void {
    this.tasks.delete(platform);
    this.publish();
  }

  async recordError(
    account: RemoteAccountEntity,
    user: UserEntity | undefined,
    failure: { error: string; at: Date; retryAt?: Date; kind?: "Result" | "Source"; details?: unknown }
  ): Promise<void> {
    try {
      const event: RemoteMonitorError = {
        id: randomBytes(12).toString("hex"),
        account: {
          accountId: account.id,
          userId: account.userId,
          username: user?.username?.slice(0, 64) || "",
          handle: account.handle.slice(0, 64)
        },
        kind: failure.kind || "Result",
        error: safeError(failure.error) || "REMOTE_SYNC_FAILED",
        at: failure.at.toISOString(),
        retryAt: iso(failure.retryAt),
        details: safeRemoteErrorDetails(failure.details)
      };
      const redis = this.redisService.getSharedClient();
      if (redis.status !== "ready") return;
      const key = `remote-monitor:errors:${account.platform}`;
      await bounded(
        redis
          .multi()
          .lpush(key, JSON.stringify(event))
          .ltrim(key, 0, ERROR_HISTORY_LIMIT - 1)
          .expire(key, ERROR_HISTORY_SECONDS)
          .exec()
      );
    } catch {
      // Diagnostics must never fail or delay the synchronization retry beyond the monitoring timeout.
    }
  }

  private async errorHistory(
    platform: SubmissionMethod
  ): Promise<{ events: RemoteMonitorError[]; available: boolean }> {
    try {
      const redis = this.redisService.getSharedClient();
      if (redis.status !== "ready") return { events: [], available: false };
      const values = await bounded(redis.lrange(`remote-monitor:errors:${platform}`, 0, ERROR_HISTORY_LIMIT - 1));
      const events = values.flatMap(value => {
        try {
          const event = JSON.parse(value) as RemoteMonitorError;
          const at = iso(event.at);
          const error = safeError(event.error);
          if (
            !at ||
            !error ||
            Date.now() - +new Date(at) > ERROR_HISTORY_SECONDS * 1000 ||
            +new Date(at) > Date.now() + 60000 ||
            !/^[a-f0-9]{24}$/.test(event.id) ||
            !Number.isSafeInteger(event.account?.accountId) ||
            !Number.isSafeInteger(event.account?.userId)
          )
            return [];
          return [
            {
              id: event.id,
              account: {
                accountId: event.account.accountId,
                userId: event.account.userId,
                username: String(event.account.username || "").slice(0, 64),
                handle: String(event.account.handle || "").slice(0, 64)
              },
              kind: event.kind === "Source" ? ("Source" as const) : ("Result" as const),
              error,
              at,
              retryAt: iso(event.retryAt),
              details: safeRemoteErrorDetails(event.details)
            }
          ];
        } catch {
          return [];
        }
      });
      return { events: events.sort((a, b) => +new Date(b.at) - +new Date(a.at)), available: true };
    } catch {
      return { events: [], available: false };
    }
  }

  // Monitoring failure must never interrupt result synchronization. Reuse the command connection.
  private publish(): void {
    this.publishing = this.publishing
      .catch(() => {
        /* Monitoring is best effort. */
      })
      .then(async () => {
        if (!this.enabled) return;
        const redis = this.redisService.getSharedClient();
        const now = Date.now();
        if (redis.status !== "ready") return;
        const pipeline = redis.pipeline();
        for (const platform of platforms) {
          const registry = `remote-monitor:workers:${platform}`;
          pipeline.zremrangebyscore(registry, "-inf", now - HEARTBEAT_MS);
          pipeline.zadd(registry, now, this.instance);
          pipeline.expire(registry, 90);
          pipeline.set(
            `remote-monitor:worker:${platform}:${this.instance}`,
            JSON.stringify({
              at: new Date(now).toISOString(),
              task: this.tasks.get(platform) || null
            }),
            "PX",
            HEARTBEAT_MS
          );
        }
        await bounded(pipeline.exec());
      })
      .catch(() => {
        /* Monitoring is best effort. */
      });
  }

  private async workers(platform: SubmissionMethod, now: number): Promise<WorkerState[]> {
    try {
      const redis = this.redisService.getSharedClient();
      if (redis.status !== "ready") return [];
      const ids = await bounded(
        redis.zrangebyscore(`remote-monitor:workers:${platform}`, now - HEARTBEAT_MS, "+inf", "LIMIT", 0, 100)
      );
      if (!ids.length) return [];
      const values = await bounded(redis.mget(...ids.map(id => `remote-monitor:worker:${platform}:${id}`)));
      return values.flatMap(value => {
        if (!value) return [];
        const row = JSON.parse(value) as WorkerState;
        const at = iso(row.at);
        if (!at || now - +new Date(at) >= HEARTBEAT_MS || +new Date(at) > now + 60000) return [];
        const task =
          row.task &&
          Number.isSafeInteger(row.task.accountId) &&
          row.task.accountId > 0 &&
          ["Syncing", "Collecting", "Importing"].includes(row.task.phase) &&
          iso(row.task.startedAt)
            ? row.task
            : null;
        return [{ at, task }];
      });
    } catch {
      return [];
    }
  }

  private accountQuery() {
    // Explicit selection: credentials, email, IPs, source payloads and verification codes never enter the snapshot.
    return this.connection
      .getRepository(RemoteAccountEntity)
      .createQueryBuilder("account")
      .leftJoin(UserEntity, "user", "user.id = account.userId")
      .select("account.id", "accountId")
      .addSelect("account.userId", "userId")
      .addSelect("user.username", "username")
      .addSelect("account.handle", "handle")
      .addSelect("account.lastError", "lastError")
      .addSelect("account.lastErrorAt", "lastErrorAt")
      .addSelect("account.nextSyncAt", "nextSyncAt")
      .addSelect("account.codeforcesSourceError", "sourceError")
      .addSelect("account.codeforcesSourceRetryAt", "sourceRetryAt");
  }

  private account(row: Record<string, unknown>): RemoteMonitorAccount {
    const retry = iso(row.sourceRetryAt);
    return {
      accountId: Number(row.accountId),
      userId: Number(row.userId),
      username: String(row.username || ""),
      handle: String(row.handle || ""),
      lastError: safeError(row.lastError),
      lastErrorAt: iso(row.lastErrorAt),
      nextSyncAt: iso(row.nextSyncAt),
      sourceError: safeError(row.sourceError),
      sourceRetryAt: retry,
      sourceErrorAt: row.sourceError && retry ? new Date(+new Date(retry) - 300000).toISOString() : null
    };
  }

  private async redisInfo(): Promise<NonNullable<RemoteJudgeMonitorSnapshot["admin"]>["redis"]> {
    const empty = {
      available: false,
      connectedClients: null,
      maxClients: null,
      rejectedConnections: null,
      rejectedDelta: null,
      deltaSince: null,
      sampledAt: null
    };
    try {
      const redis = this.redisService.getSharedClient();
      if (redis.status !== "ready") return empty;
      const [clients, stats, previous] = await bounded(
        Promise.all([redis.info("clients"), redis.info("stats"), redis.get("remote-monitor:redis-sample")])
      );
      const number = (text: string, key: string): number | null => {
        const match = text.match(new RegExp(`^${key}:(\\d+)\\r?$`, "m"));
        return match && Number.isSafeInteger(Number(match[1])) ? Number(match[1]) : null;
      };
      const rejected = number(stats, "rejected_connections");
      const sample = previous ? JSON.parse(previous) : null;
      const sampledAt = new Date().toISOString();
      const comparable =
        rejected !== null &&
        Number.isSafeInteger(sample?.rejected) &&
        sample.rejected >= 0 &&
        rejected >= sample.rejected &&
        !!iso(sample.at);
      await bounded(redis.set("remote-monitor:redis-sample", JSON.stringify({ rejected, at: sampledAt }), "EX", 86400));
      return {
        available: true,
        connectedClients: number(clients, "connected_clients"),
        maxClients: number(clients, "maxclients"),
        rejectedConnections: rejected,
        rejectedDelta: comparable ? rejected - sample.rejected : null,
        deltaSince: comparable ? iso(sample.at) : null,
        sampledAt
      };
    } catch {
      return empty;
    }
  }

  private async collect(): Promise<RemoteJudgeMonitorSnapshot> {
    const now = new Date();
    const workerGroups = await Promise.all(platforms.map(platform => this.workers(platform, +now)));
    const runningIds = [
      ...new Set(
        workerGroups.flatMap(workers => workers.flatMap(worker => (worker.task ? [worker.task.accountId] : [])))
      )
    ];
    const queued = `${DUE}${runningIds.length ? " AND account.id NOT IN (:...runningIds)" : ""}`;
    const sums = await this.connection
      .getRepository(RemoteAccountEntity)
      .createQueryBuilder("account")
      .select("account.platform", "platform")
      .addSelect("COUNT(*)", "boundAccounts")
      .addSelect(`SUM(CASE WHEN ${WORK} THEN 1 ELSE 0 END)`, "activeAccounts")
      .addSelect(`SUM(CASE WHEN ${queued} THEN 1 ELSE 0 END)`, "queuedAccounts")
      .addSelect(`SUM(CASE WHEN ${WORK} AND account.failures > 0 THEN 1 ELSE 0 END)`, "retryingAccounts")
      .addSelect(`SUM(CASE WHEN ${WORK} AND ${HISTORY} THEN 1 ELSE 0 END)`, "historyAccounts")
      .addSelect("SUM(CASE WHEN account.lastError IS NOT NULL THEN 1 ELSE 0 END)", "errorAccounts")
      .addSelect("SUM(CASE WHEN account.codeforcesSourceError IS NOT NULL THEN 1 ELSE 0 END)", "sourceErrorAccounts")
      .addSelect(
        "SUM(CASE WHEN account.lastError IS NOT NULL OR account.codeforcesSourceError IS NOT NULL THEN 1 ELSE 0 END)",
        "abnormalAccounts"
      )
      .addSelect(`MIN(CASE WHEN ${queued} THEN account.nextSyncAt ELSE NULL END)`, "oldestQueuedAt")
      .addSelect("MAX(account.lastSyncedAt)", "lastSyncedAt")
      .where("account.platform IN (:...platforms)", { platforms, now, cf: SubmissionMethod.Codeforces, runningIds })
      .groupBy("account.platform")
      .getRawMany();
    const [session, redisInfo] = await Promise.all([this.siteSettings.getRemoteJudgeSettings(), this.redisInfo()]);
    const rows: RemotePlatformMonitor[] = [];
    for (const platform of platforms) {
      const sum = sums.find(row => row.platform === platform) || {};
      const count = (field: string) => Math.max(0, Number(sum[field]) || 0);
      const workers = workerGroups[platforms.indexOf(platform)];
      const tasks = workers.flatMap(worker => (worker.task ? [worker.task] : []));
      const activeIds = [...new Set(tasks.map(task => task.accountId))];
      const [
        errors,
        activeAccounts,
        latestError,
        pendingSubmissions,
        history,
        sourcePendingSubmissions,
        sourceFailedSubmissions
      ] = await Promise.all([
        this.accountQuery()
          .where("account.platform = :platform", { platform })
          .andWhere("(account.lastError IS NOT NULL OR account.codeforcesSourceError IS NOT NULL)")
          .orderBy("account.lastErrorAt", "DESC")
          .addOrderBy("account.codeforcesSourceRetryAt", "DESC")
          .addOrderBy("account.id", "ASC")
          .limit(20)
          .getRawMany(),
        activeIds.length
          ? this.accountQuery()
              .where("account.platform = :platform AND account.id IN (:...ids)", { platform, ids: activeIds })
              .getRawMany()
          : Promise.resolve([]),
        this.connection
          .getRepository(RemoteAccountEntity)
          .createQueryBuilder("account")
          .select("account.lastError", "error")
          .addSelect("account.lastErrorAt", "at")
          .where("account.platform = :platform", { platform, now })
          .andWhere(WORK)
          .andWhere("account.lastError IS NOT NULL")
          .orderBy("account.lastErrorAt", "DESC")
          .limit(1)
          .getRawOne(),
        this.connection
          .getRepository(SubmissionEntity)
          .countBy({ remoteKey: Like(`${platform}:%`), status: SubmissionStatus.Pending }),
        this.errorHistory(platform),
        ...(["Pending", "Failed"] as const).map(sourceStatus =>
          platform === SubmissionMethod.AtCoder
            ? this.connection
                .getRepository(SubmissionEntity)
                .createQueryBuilder("source")
                .where("source.remoteKey LIKE :prefix", { prefix: "AtCoder:%" })
                .andWhere("JSON_UNQUOTE(JSON_EXTRACT(source.remote, '$.sourceSync.status')) = :sourceStatus", {
                  sourceStatus
                })
                .getCount()
            : Promise.resolve(0)
        )
      ]);
      const lastSyncedAt = iso(sum.lastSyncedAt);
      const lastHeartbeatAt =
        workers
          .map(worker => worker.at)
          .sort()
          .at(-1) || null;
      let state: RemoteMonitorState = "Unknown";
      const isAtcoder = platform === SubmissionMethod.AtCoder;
      const errorAt = iso(latestError?.at);
      const recentFailure =
        errorAt &&
        +now - +new Date(errorAt) <
          Math.max(180000, (this.configService.config.remoteJudge?.intervalSeconds ?? 30) * 3000);
      const allFailing = count("activeAccounts") > 0 && count("retryingAccounts") === count("activeAccounts");
      const sharedFailure = [
        "REMOTE_RATE_LIMITED",
        "REMOTE_ACCESS_DENIED",
        "REMOTE_UNAVAILABLE",
        ...(isAtcoder ? ["REMOTE_AUTH_REQUIRED", "REMOTE_SESSION_UNREADABLE", "REMOTE_PARSE_FAILED"] : [])
      ].includes(latestError?.error);
      if (!this.enabled) state = "Disabled";
      else if (isAtcoder && !session.atcoderSessionConfigured) state = "Unconfigured";
      else if (isAtcoder && session.atcoderSessionStatus === "expired") state = "AuthExpired";
      else if (!lastHeartbeatAt) state = "Unknown";
      else if (isAtcoder && session.atcoderSessionError === "REMOTE_SESSION_UNREADABLE") state = "Error";
      else if (count("activeAccounts") === 0) state = "Idle";
      else if (
        allFailing &&
        recentFailure &&
        sharedFailure &&
        (!lastSyncedAt || +new Date(errorAt) >= +new Date(lastSyncedAt))
      )
        state = latestError.error === "REMOTE_RATE_LIMITED" ? "RateLimited" : "Error";
      else if (tasks.length) state = "Syncing";
      else if (
        lastSyncedAt &&
        +now - +new Date(lastSyncedAt) <
          Math.max(180000, (this.configService.config.remoteJudge?.intervalSeconds ?? 30) * 3000)
      )
        state = "Healthy";
      rows.push({
        platform,
        state,
        lastSyncedAt,
        lastHeartbeatAt,
        sourceSupport: isAtcoder ? "SiteSession" : "PersonalKey",
        admin: {
          boundAccounts: count("boundAccounts"),
          activeAccounts: count("activeAccounts"),
          queuedAccounts: count("queuedAccounts"),
          retryingAccounts: count("retryingAccounts"),
          historyAccounts: count("historyAccounts"),
          pendingSubmissions,
          sourcePendingSubmissions,
          sourceFailedSubmissions,
          errorAccounts: count("errorAccounts"),
          sourceErrorAccounts: count("sourceErrorAccounts"),
          oldestQueuedAt: iso(sum.oldestQueuedAt),
          liveWorkers: workers.length,
          tasks: tasks.flatMap(task => {
            const account = activeAccounts.find(row => Number(row.accountId) === task.accountId);
            return account ? [{ account: this.account(account), phase: task.phase, startedAt: task.startedAt }] : [];
          }),
          errors: errors.map(row => {
            const account = this.account(row);
            const recent = history.events.find(
              event => event.account.accountId === account.accountId && event.kind === "Result"
            );
            const matches =
              recent?.error === account.lastError &&
              account.lastErrorAt &&
              Math.abs(+new Date(recent.at) - +new Date(account.lastErrorAt)) < 1000;
            return { ...account, ...(matches ? { lastErrorDetails: recent.details } : {}) };
          }),
          errorsTruncated: count("abnormalAccounts") > errors.length,
          recentErrors: history.events,
          errorHistoryAvailable: history.available,
          ...(isAtcoder
            ? {
                session: {
                  configured: session.atcoderSessionConfigured,
                  status: session.atcoderSessionStatus,
                  checkedAt: iso(session.atcoderSessionLastCheckedAt),
                  error: safeError(session.atcoderSessionError)
                }
              }
            : {})
        }
      });
    }
    return {
      updatedAt: now.toISOString(),
      stale: false,
      unavailable: false,
      platforms: rows,
      admin: { redis: redisInfo }
    };
  }

  private async snapshot(): Promise<RemoteJudgeMonitorSnapshot> {
    const redis = this.redisService.getSharedClient();
    let cached: RemoteJudgeMonitorSnapshot | null = null;
    try {
      if (redis.status !== "ready") throw new Error("MONITOR_REDIS_UNAVAILABLE");
      const value = await bounded(redis.get(CACHE_KEY));
      cached = value ? JSON.parse(value) : null;
      if (cached?.updatedAt && Date.now() - +new Date(cached.updatedAt) < CACHE_MS) return cached;
    } catch {
      /* Build from stored database state if the shared cache is unavailable. */
    }
    if (this.collecting) return await this.collecting;
    this.collecting = this.collect()
      .then(async snapshot => {
        this.previous = snapshot;
        try {
          if (redis.status === "ready") await bounded(redis.set(CACHE_KEY, JSON.stringify(snapshot), "EX", 90));
        } catch {
          /* Snapshot remains usable. */
        }
        return snapshot;
      })
      .catch(() => {
        const previous = cached || this.previous;
        return previous
          ? { ...previous, stale: true, unavailable: true }
          : ({
              updatedAt: null,
              stale: true,
              unavailable: true,
              platforms: platforms.map(platform => ({
                platform,
                state: this.enabled ? "Unknown" : "Disabled",
                lastSyncedAt: null,
                lastHeartbeatAt: null,
                sourceSupport: platform === SubmissionMethod.Codeforces ? "PersonalKey" : "Unavailable"
              }))
            } as RemoteJudgeMonitorSnapshot);
      })
      .finally(() => {
        this.collecting = null;
      });
    return await this.collecting;
  }

  async getSnapshot(user?: UserEntity): Promise<RemoteJudgeMonitorSnapshot> {
    const snapshot = await this.snapshot();
    // Project every response, including cached and degraded ones, before crossing the public boundary.
    return {
      updatedAt: snapshot.updatedAt,
      stale: snapshot.stale,
      unavailable: snapshot.unavailable,
      platforms: snapshot.platforms.map(row => ({
        platform: row.platform,
        state: !this.enabled ? "Disabled" : snapshot.stale ? "Unknown" : row.state,
        lastSyncedAt: row.lastSyncedAt,
        lastHeartbeatAt: row.lastHeartbeatAt,
        sourceSupport: row.sourceSupport,
        ...(user?.isAdmin && row.admin ? { admin: row.admin } : {})
      })),
      ...(user?.isAdmin && snapshot.admin ? { admin: snapshot.admin } : {})
    };
  }
}
