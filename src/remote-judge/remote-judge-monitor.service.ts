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
import { ProblemEntity } from "@/problem/problem.entity";
import { LocalizedContentEntity, LocalizedContentType } from "@/localized-content/localized-content.entity";

import { RemoteAccountEntity } from "./remote-account.entity";
import { SubmissionMethod, RemoteSubmission } from "./remote-judge.types";
import { CodeforcesImportBufferEntity } from "./codeforces-import-buffer.entity";
import { RemoteWatchEntity } from "./remote-watch.entity";
import {
  RemoteJudgeMonitorSnapshot,
  RemoteMonitorAccount,
  RemoteMonitorState,
  RemotePlatformMonitor,
  RemoteTaskPhase,
  RemoteTaskOutcome,
  RemoteFinishedTask,
  RemoteTaskContinuation,
  RemoteTaskProblem
} from "./remote-judge-monitor.types";

const platforms = [SubmissionMethod.Codeforces, SubmissionMethod.AtCoder];
const CACHE_KEY = "remote-monitor:snapshot:v3";
const CACHE_MS = 10000;
const HEARTBEAT_MS = 45000;
const HISTORY_LIMIT = 100;
const HISTORY_TTL_SECONDS = 7 * 86400;
const SCHEDULED_LIMIT = 50;
const PROBLEM_LIMIT = 50;
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
  task: {
    accountId: number;
    phase: RemoteTaskPhase;
    startedAt: string;
    problems: RemoteTaskProblem[];
    problemsTruncated: boolean;
  } | null;
}

function iso(value: unknown): string | null {
  const date = value ? new Date(value as string) : null;
  return date && Number.isFinite(+date) ? date.toISOString() : null;
}

function safeError(value: unknown): string | null {
  return typeof value === "string" && /^REMOTE_[A-Z_]{1,72}$/.test(value) ? value : value ? "REMOTE_SYNC_FAILED" : null;
}

function safeProblems(value: unknown): RemoteTaskProblem[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, PROBLEM_LIMIT).flatMap(row => {
    if (
      !row ||
      !Number.isSafeInteger(row.problemId) ||
      row.problemId <= 0 ||
      typeof row.title !== "string" ||
      typeof row.remoteKey !== "string" ||
      !["Watching", "Collecting", "Queued", "Importing", "Succeeded", "Skipped", "Failed"].includes(row.state)
    )
      return [];
    const count = (n: unknown) => (Number.isSafeInteger(n) && Number(n) >= 0 ? Number(n) : 0);
    return [
      {
        problemId: row.problemId,
        displayId: Number.isSafeInteger(row.displayId) && row.displayId > 0 ? row.displayId : null,
        title: row.title.slice(0, 180),
        remoteKey: row.remoteKey.slice(0, 180),
        scope: ["Buffer", "Watch"].includes(row.scope) ? row.scope : "Round",
        state: row.state,
        records: row.records === null ? null : count(row.records),
        processed: count(row.processed),
        synchronized: count(row.synchronized)
      }
    ];
  });
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
    this.tasks.set(platform, {
      accountId,
      phase,
      startedAt: new Date().toISOString(),
      problems: [],
      problemsTruncated: false
    });
    this.publish();
  }

  setTaskPhase(platform: SubmissionMethod, phase: RemoteTaskPhase): void {
    const task = this.tasks.get(platform);
    if (task && task.phase !== phase) {
      task.phase = phase;
      this.publish();
    }
  }

  setTaskProblems(
    platform: SubmissionMethod,
    problems: ProblemEntity[],
    submissions: RemoteSubmission[],
    state: "Collecting" | "Queued" = "Queued"
  ): void {
    const task = this.tasks.get(platform);
    if (!task) return;
    task.problemsTruncated = problems.length > PROBLEM_LIMIT;
    task.problems = problems.slice(0, PROBLEM_LIMIT).map(problem => ({
      problemId: problem.id,
      displayId: problem.displayId || null,
      title: "",
      remoteKey: problem.remoteProblemKey,
      scope: "Round",
      state,
      records: submissions.filter(row => `${row.contestId}:${row.taskId}` === problem.remoteProblemKey).length,
      processed: 0,
      synchronized: 0
    }));
    this.publish();
  }

  beginProblem(platform: SubmissionMethod, problemId: number): void {
    const problem = this.tasks.get(platform)?.problems.find(row => row.problemId === problemId);
    if (problem) problem.state = "Importing";
  }

  finishProblem(platform: SubmissionMethod, problemId: number, synchronized: boolean): void {
    const problem = this.tasks.get(platform)?.problems.find(row => row.problemId === problemId);
    if (!problem) return;
    problem.processed++;
    if (synchronized) problem.synchronized++;
    problem.state =
      problem.processed >= (problem.records || 0) ? (problem.synchronized ? "Succeeded" : "Skipped") : "Importing";
  }

  finishTask(platform: SubmissionMethod, outcome?: RemoteTaskOutcome): void {
    const task = this.tasks.get(platform);
    this.tasks.delete(platform);
    const finishedAt = new Date();
    const record: RemoteFinishedTask | undefined = task
      ? {
          id: randomBytes(12).toString("hex"),
          accountId: task.accountId,
          phase: task.phase,
          startedAt: task.startedAt,
          finishedAt: finishedAt.toISOString(),
          durationMs: Math.max(0, +finishedAt - +new Date(task.startedAt)),
          state: outcome?.state || "Skipped",
          continuation: outcome?.continuation || "None",
          processed: Math.max(0, Math.floor(outcome?.processed || 0)),
          nextSyncAt: iso(outcome?.nextSyncAt),
          error: safeError(outcome?.error),
          sourceError: safeError(outcome?.sourceError),
          problems: safeProblems(task.problems).map(problem => ({
            ...problem,
            state: outcome?.state === "Failed" && problem.state === "Importing" ? "Failed" : problem.state
          })),
          problemsTruncated: task.problemsTruncated
        }
      : undefined;
    this.publish(record ? { platform, record } : undefined);
  }

  // Monitoring failure must never interrupt result synchronization. Reuse the command connection.
  private publish(completed?: { platform: SubmissionMethod; record: RemoteFinishedTask }): void {
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
        if (completed) {
          const key = `remote-monitor:history:${completed.platform}`;
          pipeline.lpush(key, JSON.stringify(completed.record));
          pipeline.ltrim(key, 0, HISTORY_LIMIT - 1);
          pipeline.expire(key, HISTORY_TTL_SECONDS);
        }
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

  private async history(
    platform: SubmissionMethod,
    now: number
  ): Promise<{ available: boolean; records: RemoteFinishedTask[] }> {
    try {
      const redis = this.redisService.getSharedClient();
      if (redis.status !== "ready") return { available: false, records: [] };
      const values = await bounded(redis.lrange(`remote-monitor:history:${platform}`, 0, HISTORY_LIMIT - 1));
      const records = values.flatMap(value => {
        try {
          const row = JSON.parse(value) as RemoteFinishedTask;
          const startedAt = iso(row.startedAt);
          const finishedAt = iso(row.finishedAt);
          if (
            !startedAt ||
            !finishedAt ||
            !/^[a-f0-9]{24}$/.test(row.id) ||
            !Number.isSafeInteger(row.accountId) ||
            row.accountId <= 0 ||
            !["Syncing", "Collecting", "Importing"].includes(row.phase) ||
            !["Succeeded", "Failed", "Skipped"].includes(row.state) ||
            +new Date(finishedAt) < +new Date(startedAt) ||
            +new Date(finishedAt) > now + 60000 ||
            now - +new Date(finishedAt) > HISTORY_TTL_SECONDS * 1000
          )
            return [];
          const continuation: RemoteTaskContinuation = [
            "None",
            "More",
            "Pending",
            "Polling",
            "Retry",
            "Paused",
            "Inactive"
          ].includes(row.continuation)
            ? row.continuation
            : "None";
          return [
            {
              id: row.id,
              accountId: row.accountId,
              phase: row.phase,
              state: row.state,
              continuation,
              startedAt,
              finishedAt,
              durationMs: +new Date(finishedAt) - +new Date(startedAt),
              processed: Number.isSafeInteger(row.processed) && row.processed >= 0 ? row.processed : 0,
              problems: safeProblems(row.problems),
              problemsTruncated: row.problemsTruncated === true,
              nextSyncAt: iso(row.nextSyncAt),
              error: safeError(row.error),
              sourceError: safeError(row.sourceError)
            }
          ];
        } catch {
          return [];
        }
      });
      return { available: true, records: records.sort((a, b) => +new Date(b.finishedAt) - +new Date(a.finishedAt)) };
    } catch {
      return { available: false, records: [] };
    }
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
        return [
          {
            at,
            task: task
              ? {
                  accountId: task.accountId,
                  phase: task.phase,
                  startedAt: task.startedAt,
                  problems: safeProblems(task.problems),
                  problemsTruncated: task.problemsTruncated === true
                }
              : null
          }
        ];
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

  private async problemTargets(platform: SubmissionMethod, accountIds: number[], now: Date) {
    const result = new Map<number, { problems: RemoteTaskProblem[]; truncated: boolean }>();
    if (!accountIds.length) return result;
    const limit = 1000;
    const selectProblems = (builder: ReturnType<DataSource["createQueryBuilder"]>, alias: string) =>
      builder
        .select(`${alias}.accountId`, "accountId")
        .addSelect("problem.id", "problemId")
        .addSelect("''", "title")
        .addSelect("problem.remoteProblemKey", "remoteKey")
        .groupBy(`${alias}.accountId`)
        .addGroupBy("problem.id")
        .addGroupBy("problem.remoteProblemKey")
        .orderBy(`${alias}.accountId`, "ASC")
        .addOrderBy("problem.id", "ASC")
        .limit(limit + 1);
    const [buffered, watched] = await Promise.all([
      platform === SubmissionMethod.Codeforces
        ? selectProblems(
            this.connection
              .getRepository(CodeforcesImportBufferEntity)
              .createQueryBuilder("entry")
              .innerJoin(
                RemoteAccountEntity,
                "account",
                "account.id = entry.accountId AND entry.batch = JSON_UNQUOTE(JSON_EXTRACT(account.scan, '$.bufferKey'))"
              )
              .innerJoin(
                ProblemEntity,
                "problem",
                "problem.remoteProblemKey = entry.problemKey AND problem.submissionMethod = :platform"
              )
              .where("entry.accountId IN (:...accountIds)", { accountIds, platform }),
            "entry"
          )
            .addSelect("COUNT(*)", "records")
            .addSelect(
              "CASE WHEN JSON_EXTRACT(account.scan, '$.importCursor') IS NULL THEN 'Collecting' ELSE 'Queued' END",
              "state"
            )
            .addGroupBy("account.scan")
            .getRawMany()
        : Promise.resolve([]),
      selectProblems(
        this.connection
          .getRepository(RemoteWatchEntity)
          .createQueryBuilder("watch")
          .innerJoin(ProblemEntity, "problem", "problem.id = watch.problemId AND problem.submissionMethod = :platform")
          .where("watch.accountId IN (:...accountIds) AND watch.until >= :since", {
            accountIds,
            platform,
            since: new Date(+now - 86400000)
          }),
        "watch"
      ).getRawMany()
    ]);
    const globallyTruncated = buffered.length > limit || watched.length > limit;
    for (const row of [...buffered.slice(0, limit), ...watched.slice(0, limit)]) {
      const id = Number(row.accountId);
      if (!result.has(id)) result.set(id, { problems: [], truncated: globallyTruncated });
      const group = result.get(id);
      if (group.problems.some(problem => problem.problemId === Number(row.problemId))) continue;
      if (group.problems.length >= PROBLEM_LIMIT) {
        group.truncated = true;
        continue;
      }
      group.problems.push(
        ...safeProblems([
          {
            problemId: Number(row.problemId),
            title: row.title,
            remoteKey: row.remoteKey,
            scope: row.records ? "Buffer" : "Watch",
            state: row.records ? row.state : "Watching",
            records: row.records ? Number(row.records) : null,
            processed: 0,
            synchronized: 0
          }
        ])
      );
    }
    for (const id of accountIds) if (!result.has(id)) result.set(id, { problems: [], truncated: globallyTruncated });
    return result;
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

  private async hydrateProblemTitles(rows: RemotePlatformMonitor[]): Promise<void> {
    const problems = rows.flatMap(row => [
      ...(row.admin?.tasks.flatMap(task => task.problems) || []),
      ...(row.admin?.scheduledTasks.flatMap(task => task.problems) || []),
      ...(row.admin?.history.flatMap(task => task.problems) || [])
    ]);
    const ids = [...new Set(problems.map(problem => problem.problemId))];
    if (!ids.length) return;
    const titles = await this.connection
      .getRepository(ProblemEntity)
      .createQueryBuilder("problem")
      .leftJoin(
        LocalizedContentEntity,
        "title",
        "title.objectId = problem.id AND title.type = :titleType AND title.locale = JSON_UNQUOTE(JSON_EXTRACT(problem.locales, '$[0]'))",
        { titleType: LocalizedContentType.ProblemTitle }
      )
      .select("problem.id", "id")
      .addSelect("problem.displayId", "displayId")
      .addSelect("LEFT(title.data, 180)", "title")
      .where("problem.id IN (:...ids)", { ids })
      .getRawMany();
    const byId = new Map(titles.map(title => [Number(title.id), title]));
    for (const problem of problems) {
      const meta = byId.get(problem.problemId);
      if (meta) {
        problem.title = typeof meta.title === "string" ? meta.title.slice(0, 180) : "";
        problem.displayId = Number.isSafeInteger(meta.displayId) && meta.displayId > 0 ? meta.displayId : null;
      }
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
      const history = await this.history(platform, +now);
      const activeIds = [
        ...new Set([...tasks.map(task => task.accountId), ...history.records.map(task => task.accountId)])
      ];
      const scheduledQuery = this.accountQuery()
        .addSelect(
          `CASE WHEN account.platform = :cf AND JSON_EXTRACT(account.scan, '$.importCursor') IS NOT NULL THEN 'Importing' WHEN ${HISTORY} THEN 'Collecting' ELSE 'Syncing' END`,
          "phase"
        )
        .where("account.platform = :platform", { platform, now, cf: SubmissionMethod.Codeforces })
        .andWhere(WORK);
      if (runningIds.length) scheduledQuery.andWhere("account.id NOT IN (:...runningIds)", { runningIds });
      const [errors, activeAccounts, latestError, pendingSubmissions, scheduled] = await Promise.all([
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
        scheduledQuery
          .orderBy("account.nextSyncAt", "ASC")
          .addOrderBy("account.id", "ASC")
          .limit(SCHEDULED_LIMIT + 1)
          .getRawMany()
      ]);
      const lastSyncedAt = iso(sum.lastSyncedAt);
      const targets = await this.problemTargets(
        platform,
        [
          ...new Set([
            ...tasks.map(task => task.accountId),
            ...scheduled.slice(0, SCHEDULED_LIMIT).map(row => Number(row.accountId))
          ])
        ],
        now
      );
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
        sourceSupport: isAtcoder ? "Unavailable" : "PersonalKey",
        admin: {
          boundAccounts: count("boundAccounts"),
          activeAccounts: count("activeAccounts"),
          queuedAccounts: count("queuedAccounts"),
          retryingAccounts: count("retryingAccounts"),
          historyAccounts: count("historyAccounts"),
          pendingSubmissions,
          errorAccounts: count("errorAccounts"),
          sourceErrorAccounts: count("sourceErrorAccounts"),
          oldestQueuedAt: iso(sum.oldestQueuedAt),
          liveWorkers: workers.length,
          tasks: tasks.flatMap(task => {
            const account = activeAccounts.find(row => Number(row.accountId) === task.accountId);
            const known = targets.get(task.accountId);
            return account
              ? [
                  {
                    account: this.account(account),
                    phase: task.phase,
                    startedAt: task.startedAt,
                    problems: task.problems.length ? task.problems : known?.problems || [],
                    problemsTruncated: task.problemsTruncated || (!task.problems.length && !!known?.truncated)
                  }
                ]
              : [];
          }),
          scheduledTasks: scheduled.slice(0, SCHEDULED_LIMIT).map(row => ({
            account: this.account(row),
            phase: ["Collecting", "Importing"].includes(row.phase) ? row.phase : "Syncing",
            state:
              !this.enabled ||
              (isAtcoder &&
                (!session.atcoderSessionConfigured ||
                  session.atcoderSessionStatus === "expired" ||
                  session.atcoderSessionError === "REMOTE_SESSION_UNREADABLE"))
                ? "Paused"
                : row.lastError
                ? "Retrying"
                : iso(row.nextSyncAt) && +new Date(row.nextSyncAt) <= +now
                ? "Queued"
                : "Scheduled",
            scheduledAt: iso(row.nextSyncAt),
            problems: targets.get(Number(row.accountId))?.problems || [],
            problemsTruncated: targets.get(Number(row.accountId))?.truncated || false
          })),
          scheduledTaskTotal: Math.max(0, count("activeAccounts") - new Set(tasks.map(task => task.accountId)).size),
          scheduledTasksTruncated: scheduled.length > SCHEDULED_LIMIT,
          history: history.records.map(task => ({
            ...task,
            account: activeAccounts.some(row => Number(row.accountId) === task.accountId)
              ? this.account(activeAccounts.find(row => Number(row.accountId) === task.accountId))
              : null
          })),
          historyAvailable: history.available,
          errors: errors.map(row => this.account(row)),
          errorsTruncated: count("abnormalAccounts") > errors.length,
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
    await this.hydrateProblemTitles(rows);
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
