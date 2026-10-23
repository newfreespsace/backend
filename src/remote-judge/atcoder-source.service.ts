/* eslint-disable no-await-in-loop -- Discover a bounded batch and fetch one source per worker turn. */
import { randomBytes } from "crypto";

import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";

import { DataSource } from "typeorm";

import { ConfigService } from "@/config/config.service";
import { ContestService, ContestPermissionType } from "@/contest/contest.service";
import { logger } from "@/logger";
import { ProblemService, ProblemPermissionType } from "@/problem/problem.service";
import { LockService } from "@/redis/lock.service";
import { RedisService } from "@/redis/redis.service";
import { SubmissionEntity } from "@/submission/submission.entity";
import { SubmissionService } from "@/submission/submission.service";
import { SubmissionStatus } from "@/submission/submission-status.enum";
import { UserService } from "@/user/user.service";

import { RemoteAccountEntity } from "./remote-account.entity";
import { RemoteProviderService } from "./remote-provider.service";
import { RemoteSourceSync, SubmissionMethod } from "./remote-judge.types";

@Injectable()
export class AtcoderSourceService implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval>;

  private running = false;

  constructor(
    @InjectDataSource() private readonly connection: DataSource,
    private readonly config: ConfigService,
    private readonly redis: RedisService,
    private readonly locks: LockService,
    private readonly provider: RemoteProviderService,
    private readonly submissions: SubmissionService,
    private readonly users: UserService,
    private readonly problems: ProblemService,
    private readonly contests: ContestService
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      if (this.running || this.config.config.remoteJudge?.enabled === false) return;
      this.running = true;
      this.tick()
        .catch(() => logger.warn("AtCoder source worker: REMOTE_SOURCE_WORKER_FAILED"))
        .finally(() => {
          this.running = false;
        });
    }, 5000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  private async discover(): Promise<void> {
    const repository = this.connection.getRepository(SubmissionEntity);
    const rows = await repository
      .createQueryBuilder("submission")
      .where("submission.remoteKey LIKE :prefix", { prefix: "AtCoder:%" })
      .andWhere("JSON_EXTRACT(submission.remote, '$.sourceSync.status') IS NULL")
      .andWhere("submission.status != :pending", { pending: SubmissionStatus.Pending })
      .orderBy("submission.id", "ASC")
      .take(100)
      .getMany();
    for (const row of rows) {
      await this.updateSourceSync(row, current =>
        current.remote.sourceSync
          ? undefined
          : {
              status: current.remote.sourceAvailable ? "Available" : "Pending",
              ...(current.remote.sourceAvailable ? {} : { nextAttemptAt: new Date().toISOString() }),
              failures: 0
            }
      );
    }
  }

  // Result imports and source writes share this lock; always merge the latest remote JSON.
  private async updateSourceSync(
    expected: SubmissionEntity,
    update: (current: SubmissionEntity) => RemoteSourceSync | undefined
  ): Promise<RemoteSourceSync | undefined> {
    return await this.locks.lock(
      `RemoteSubmission_${expected.remoteKey}`,
      async () =>
        await this.locks.lock(`Submission_${expected.id}`, async () => {
          const repository = this.connection.getRepository(SubmissionEntity);
          const current = await repository.findOneBy({ id: expected.id });
          if (
            !current ||
            current.remoteKey !== expected.remoteKey ||
            current.remote?.platform !== SubmissionMethod.AtCoder
          )
            return undefined;
          const sourceSync = update(current);
          if (!sourceSync) return undefined;
          await repository.update({ id: current.id }, { remote: { ...current.remote, sourceSync } });
          return sourceSync;
        })
    );
  }

  private async tick(): Promise<void> {
    if (this.config.config.remoteJudge?.enabled === false) return;
    const redis = this.redis.getSharedClient();
    const token = randomBytes(12).toString("hex");
    const claim = "remote-atcoder-source-claim";
    if (!(await redis.set(claim, token, "PX", 120000, "NX"))) return;
    try {
      await this.discover();
      // Result requests take priority over the lower-priority source backfill.
      const dueResults = await this.connection
        .getRepository(RemoteAccountEntity)
        .createQueryBuilder("account")
        .where("account.platform = :platform AND account.nextSyncAt <= :now", {
          platform: SubmissionMethod.AtCoder,
          now: new Date()
        })
        .andWhere(
          "(account.activeUntil > :now OR account.catchUpRequested = 1) AND account.atcoderSessionConfigured = 1"
        )
        .getCount();
      if (dueResults) return;
      const candidate = await this.connection
        .getRepository(SubmissionEntity)
        .createQueryBuilder("submission")
        .where("JSON_UNQUOTE(JSON_EXTRACT(submission.remote, '$.sourceSync.status')) IN (:...states)", {
          states: ["Pending", "Failed"]
        })
        .andWhere("JSON_UNQUOTE(JSON_EXTRACT(submission.remote, '$.sourceSync.nextAttemptAt')) <= :now", {
          now: new Date().toISOString()
        })
        .andWhere("submission.remoteKey LIKE :prefix", { prefix: "AtCoder:%" })
        .andWhere(
          "EXISTS (SELECT 1 FROM remote_account account WHERE account.userId = submission.submitterId AND account.platform = 'AtCoder' AND account.atcoderSessionConfigured = 1)"
        )
        .andWhere("submission.status != :pending", { pending: SubmissionStatus.Pending })
        .orderBy(
          "CAST(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(submission.remote, '$.sourceSync.failures')), '0') AS UNSIGNED)",
          "ASC"
        )
        .addOrderBy("submission.id", "DESC")
        .take(1)
        .getOne();
      if (candidate) await this.process(candidate);
    } finally {
      await redis.eval(
        "if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) end return 0",
        1,
        claim,
        token
      );
    }
  }

  private async process(candidate: SubmissionEntity): Promise<void> {
    const repository = this.connection.getRepository(SubmissionEntity);
    try {
      const handle = candidate.remote?.handle;
      if (!handle) throw new Error("REMOTE_SOURCE_IDENTITY_MISMATCH");
      const account = await this.connection.getRepository(RemoteAccountEntity).findOneBy({
        userId: candidate.submitterId,
        platform: SubmissionMethod.AtCoder,
        handleKey: handle.toLowerCase()
      });
      if (!account) throw new Error("REMOTE_SOURCE_ACCOUNT_UNBOUND");
      // Unbinding and result imports use the same account lock. Re-read after acquiring it.
      await this.locks.lock(`RemoteAccount_${account.id}`, async () => {
        const bound = await this.connection.getRepository(RemoteAccountEntity).findOneBy({ id: account.id });
        const submission = await repository.findOneBy({ id: candidate.id });
        if (!submission || submission.status === SubmissionStatus.Pending) return;
        if (
          submission.remote?.sourceSync?.nextAttemptAt &&
          Date.parse(submission.remote.sourceSync.nextAttemptAt) > Date.now()
        )
          return;
        if (submission.remote?.sourceAvailable) {
          await this.updateSourceSync(submission, current =>
            current.remote.sourceSync?.status === "Available" ? undefined : { status: "Available", failures: 0 }
          );
          return;
        }
        const { remote } = submission;
        if (
          !bound ||
          bound.userId !== submission.submitterId ||
          bound.platform !== SubmissionMethod.AtCoder ||
          bound.handleKey !== remote?.handle?.toLowerCase() ||
          remote?.platform !== SubmissionMethod.AtCoder ||
          submission.remoteKey !== `AtCoder:${remote.id}:${submission.problemId}`
        )
          throw new Error("REMOTE_SOURCE_IDENTITY_MISMATCH");
        const user = await this.users.findUserById(submission.submitterId);
        if (!user?.isActive) throw new Error("REMOTE_SOURCE_ACCESS_CHANGED");
        await this.problems.lockProblemById(submission.problemId, "Read", async problem => {
          if (
            !problem ||
            problem.submissionMethod !== SubmissionMethod.AtCoder ||
            problem.remoteProblem?.contestId !== remote.contestId ||
            problem.remoteProblem?.taskId !== remote.taskId
          )
            throw new Error("REMOTE_SOURCE_ACCESS_CHANGED");
          const restricted = await this.contests.getContestAccessRestriction(user);
          if (submission.contestId) {
            const contest = await this.contests.findContestById(submission.contestId);
            if (
              !contest ||
              contest.problemIds[submission.contestProblemIndex - 1] !== problem.id ||
              (restricted.length > 0 && !restricted.some(item => item.id === contest.id)) ||
              !(await this.contests.userHasPermission(user, contest, ContestPermissionType.View))
            )
              throw new Error("REMOTE_SOURCE_ACCESS_CHANGED");
          } else if (
            restricted.length > 0 ||
            !(await this.problems.userHasPermission(user, problem, ProblemPermissionType.View))
          )
            throw new Error("REMOTE_SOURCE_ACCESS_CHANGED");
          const session = await this.provider.getAtcoderSessionContext(bound.id);
          const wait = session.cooldownMs;
          if (wait > 0 || !session.session) {
            await this.updateSourceSync(submission, current => ({
              ...current.remote.sourceSync,
              nextAttemptAt: new Date(Date.now() + Math.max(wait, 60000)).toISOString()
            }));
            return;
          }
          const source = await this.provider.getAtcoderSource(
            {
              id: remote.id,
              contestId: remote.contestId,
              taskId: remote.taskId,
              handle: remote.handle
            },
            bound.id,
            session
          );
          await this.submissions.saveRemoteSource(submission, source);
        });
      });
    } catch (error) {
      if (error.message === "REMOTE_COOLDOWN") return;
      const code = /^REMOTE_[A-Z_]{1,72}$/.test(error?.message) ? error.message : "REMOTE_SOURCE_FAILED";
      const saved = await this.updateSourceSync(candidate, current => {
        if (current.remote.sourceAvailable) return undefined;
        const failures = Math.min((current.remote.sourceSync?.failures || 0) + 1, 30);
        return {
          status: "Failed",
          failures,
          error: code,
          nextAttemptAt: new Date(Date.now() + Math.min(3600000, 60000 * 2 ** Math.min(failures - 1, 6))).toISOString()
        };
      });
      if (!saved) return;
      logger.warn(`AtCoder source submission ${candidate.id}: ${code}`);
    }
  }
}
