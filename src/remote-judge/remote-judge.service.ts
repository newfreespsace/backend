/* eslint-disable no-await-in-loop -- Preserve ordered, bounded database writes and account updates during sync. */
import { randomBytes, randomInt } from "crypto";

import { BadRequestException, ForbiddenException, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";

import { InjectDataSource, InjectRepository } from "@nestjs/typeorm";

import { DataSource, In, Repository } from "typeorm";

import { AuditLogObjectType, AuditService } from "@/audit/audit.service";
import { ProblemJudgeInfoEntity } from "@/problem/problem-judge-info.entity";

import { RedisService } from "@/redis/redis.service";
import { LockService } from "@/redis/lock.service";
import { ConfigService } from "@/config/config.service";
import { UserService } from "@/user/user.service";
import { UserEntity } from "@/user/user.entity";
import { ProblemEntity, ProblemType } from "@/problem/problem.entity";
import { ProblemFileEntity } from "@/problem/problem-file.entity";
import { ProblemService, ProblemPermissionType } from "@/problem/problem.service";
import { ContestService, ContestPermissionType } from "@/contest/contest.service";
import { SubmissionService } from "@/submission/submission.service";
import { SubmissionEntity } from "@/submission/submission.entity";
import { SubmissionStatus } from "@/submission/submission-status.enum";

import { logger } from "@/logger";

import { RemoteAccountEntity } from "./remote-account.entity";
import { RemoteWatchEntity } from "./remote-watch.entity";
import { AtcoderLiveTarget, RemotePage, RemoteProviderService } from "./remote-provider.service";
import {
  BindRemoteAccountDto,
  RemoteContextDto,
  SetSubmissionMethodDto,
  SetCodeforcesCredentialsDto
} from "./remote-judge.dto";
import { parseRemoteProblem, RemoteSubmission, SubmissionMethod } from "./remote-judge.types";
import { CodeforcesCredentialsService, validCodeforcesCredentials } from "./codeforces-credentials.service";
import { CodeforcesImportBufferService } from "./codeforces-import-buffer.service";
import { RemoteJudgeMonitorService } from "./remote-judge-monitor.service";
import { RemoteTaskOutcome } from "./remote-judge-monitor.types";

@Injectable()
export class RemoteJudgeService implements OnModuleInit, OnModuleDestroy {
  private timer: ReturnType<typeof setInterval>;

  private readonly running = new Set<SubmissionMethod>();

  constructor(
    @InjectRepository(RemoteAccountEntity) private readonly accounts: Repository<RemoteAccountEntity>,
    @InjectRepository(RemoteWatchEntity) private readonly watches: Repository<RemoteWatchEntity>,
    @InjectDataSource() private readonly connection: DataSource,
    private readonly redisService: RedisService,
    private readonly lockService: LockService,
    private readonly configService: ConfigService,
    private readonly provider: RemoteProviderService,
    private readonly users: UserService,
    private readonly problems: ProblemService,
    private readonly submissions: SubmissionService,
    private readonly contests: ContestService,
    private readonly audit: AuditService,
    private readonly codeforcesCredentials: CodeforcesCredentialsService,
    private readonly codeforcesImportBuffer: CodeforcesImportBufferService,
    private readonly monitor: RemoteJudgeMonitorService
  ) {}

  private get settings() {
    const config = this.configService.config.remoteJudge;
    return {
      enabled: config?.enabled ?? true,
      intervalSeconds: config?.intervalSeconds ?? 30,
      activeMinutes: config?.activeMinutes ?? 10
    };
  }

  onModuleInit(): void {
    this.timer = setInterval(() => {
      if (!this.settings.enabled) return;
      for (const platform of [SubmissionMethod.Codeforces, SubmissionMethod.AtCoder]) {
        if (this.running.has(platform)) continue;
        this.running.add(platform);
        this.tick(platform)
          .catch(error => logger.warn(`Remote sync worker: ${error.message}`))
          .finally(() => this.running.delete(platform));
      }
    }, 1000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  async list(user: UserEntity) {
    const accounts = await this.accounts.findBy({ userId: user.id });
    return {
      enabled: this.settings.enabled,
      accounts: accounts.map(account => ({
        platform: account.platform,
        handle: account.handle,
        verifiedAt: account.verifiedAt,
        lastSyncedAt: account.lastSyncedAt,
        nextSyncAt: account.nextSyncAt,
        activeUntil: account.activeUntil,
        lastError: account.lastError,
        codeforcesSourceEnabled: !!account.codeforcesSourceEnabled,
        codeforcesSourceError: account.codeforcesSourceError,
        codeforcesSourceRetryAt: account.codeforcesSourceRetryAt,
        importingHistory:
          this.settings.enabled &&
          !account.lastError &&
          account.platform === SubmissionMethod.Codeforces &&
          (!!account.scan || (account.cursor === "0" && account.catchUpRequested))
      }))
    };
  }

  async beginBinding(user: UserEntity, request: BindRemoteAccountDto) {
    if (!/^[a-zA-Z0-9_.-]{3,64}$/.test(request.handle)) throw new BadRequestException("INVALID_HANDLE");
    const redis = this.redisService.getSharedClient();
    if (!(await redis.set(`remote-bind-rate:${user.id}`, "1", "EX", 30, "NX")))
      throw new BadRequestException("BIND_COOLDOWN");
    // Keep the proof short enough for remote profile fields: NSOJ- plus six uppercase letters.
    const code = `NSOJ-${Array.from({ length: 6 }, () => String.fromCharCode(65 + randomInt(26))).join("")}`;
    await redis.set(
      `remote-bind:${user.id}:${request.platform}`,
      JSON.stringify({ handle: request.handle, code }),
      "EX",
      900
    );
    return { code, expiresIn: 900 };
  }

  async verifyBinding(user: UserEntity, platform: SubmissionMethod) {
    return await this.lockService.lock(`RemoteAccountUser_${user.id}_${platform}`, async () => {
      const redis = this.redisService.getSharedClient();
      const key = `remote-bind:${user.id}:${platform}`;
      const pending = JSON.parse(await redis.get(key));
      if (!pending) throw new BadRequestException("VERIFICATION_EXPIRED");
      if (!(await redis.set(`remote-verify-rate:${user.id}`, "1", "EX", 10, "NX")))
        throw new BadRequestException("BIND_COOLDOWN");
      if (!(await this.provider.verifyProfile(platform, pending.handle, pending.code)))
        throw new BadRequestException("VERIFICATION_MISMATCH");
      const handleKey = pending.handle.toLowerCase();
      return await this.lockService.lock(`RemoteAccountHandle_${platform}_${handleKey}`, async () => {
        if (await this.accounts.findOneBy({ platform, handleKey }))
          throw new BadRequestException("ACCOUNT_ALREADY_BOUND");
        if (await this.accounts.findOneBy({ userId: user.id, platform })) throw new BadRequestException("UNBIND_FIRST");
        await this.accounts.save(
          this.accounts.create({
            userId: user.id,
            platform,
            handle: pending.handle,
            handleKey,
            verifiedAt: new Date(),
            cursor: "0",
            nextSyncAt: new Date(),
            activeUntil: new Date(0),
            catchUpRequested: true,
            scan: null,
            failures: 0,
            lastError: null
          })
        );
        await redis.del(key);
        return await this.list(user);
      });
    });
  }

  async unbind(user: UserEntity, platform: SubmissionMethod) {
    return await this.lockService.lock(`RemoteAccountUser_${user.id}_${platform}`, async () => {
      const account = await this.accounts.findOneBy({ userId: user.id, platform });
      if (account)
        await this.lockService.lock(`RemoteAccount_${account.id}`, async () => {
          await this.accounts.delete({ id: account.id });
        });
      await this.redisService.getSharedClient().del(`remote-bind:${user.id}:${platform}`);
      return await this.list(user);
    });
  }

  async setCodeforcesCredentials(user: UserEntity, request: SetCodeforcesCredentialsDto) {
    const credentials = {
      apiKey: typeof request.apiKey === "string" ? request.apiKey.trim() : undefined,
      apiSecret: typeof request.apiSecret === "string" ? request.apiSecret.trim() : undefined
    };
    if (
      (request.clear !== undefined && typeof request.clear !== "boolean") ||
      (request.clear && (request.apiKey !== undefined || request.apiSecret !== undefined)) ||
      (!request.clear && !validCodeforcesCredentials(credentials))
    )
      throw new BadRequestException("INVALID_CF_CREDENTIALS");
    return await this.lockService.lock(`RemoteAccountUser_${user.id}_${SubmissionMethod.Codeforces}`, async () => {
      const account = await this.accounts.findOneBy({ userId: user.id, platform: SubmissionMethod.Codeforces });
      if (!account) throw new BadRequestException("CF_ACCOUNT_REQUIRED");
      await this.lockService.lock(`RemoteAccount_${account.id}`, async () => {
        await this.accounts.update(
          { id: account.id },
          {
            codeforcesCredentials: request.clear ? null : this.codeforcesCredentials.encrypt(account, credentials),
            codeforcesSourceEnabled: !request.clear,
            codeforcesSourceError: null,
            codeforcesSourceRetryAt: null,
            ...(!request.clear
              ? {
                  cursor: "0",
                  scan: null,
                  codeforcesSummaryVersion: 1,
                  catchUpRequested: true,
                  catchUpVersion: () => "catchUpVersion + 1",
                  nextSyncAt: new Date(),
                  failures: 0,
                  lastError: null
                }
              : {})
          }
        );
      });
      return await this.list(user);
    });
  }

  private async context(user: UserEntity, request: RemoteContextDto) {
    if (!request.problemId) throw new BadRequestException("PROBLEM_REQUIRED");
    const problem = await this.problems.findProblemById(request.problemId);
    if (!problem) throw new BadRequestException("NO_SUCH_PROBLEM");
    let contest;
    if (request.contestId) {
      contest = await this.contests.findContestById(request.contestId);
      if (
        !contest ||
        !request.contestProblemIndex ||
        contest.problemIds[request.contestProblemIndex - 1] !== problem.id
      )
        throw new BadRequestException("NO_SUCH_CONTEST_PROBLEM");
      if (
        !(await this.contests.userHasPermission(user, contest, ContestPermissionType.View)) ||
        !this.contests.isUnveiled(contest, user)
      )
        throw new ForbiddenException();
    } else if (!(await this.problems.userHasPermission(user, problem, ProblemPermissionType.View)))
      throw new ForbiddenException();
    if (!problem.remoteProblem || problem.submissionMethod === SubmissionMethod.Local)
      throw new BadRequestException("NOT_REMOTE_PROBLEM");
    return { problem, contest };
  }

  async activate(user: UserEntity, request: RemoteContextDto) {
    let platform: SubmissionMethod;
    if (request.problemId) {
      const { problem, contest } = await this.context(user, request);
      platform = problem.submissionMethod;
      const account = await this.accounts.findOneBy({ userId: user.id, platform });
      if (account) {
        const [, submittable] = await this.problems.getProblemJudgeInfo(problem);
        if (submittable) {
          const firstVisit = await this.lockService.lock(`RemoteWatch_${account.id}_${problem.id}`, async () => {
            const now = new Date();
            const last = await this.watches.findOne({
              where: { accountId: account.id, problemId: problem.id },
              order: { startedAt: "DESC", id: "DESC" }
            });
            const until =
              contest && this.contests.isRunning(contest, now)
                ? contest.endTime
                : new Date(Date.now() + this.settings.activeMinutes * 60000);
            if (last && last.contestId === (contest?.id || 0) && last.until > now) {
              await this.watches.update({ id: last.id }, { until });
            } else {
              // Close the preceding interval but retain it for delayed upstream results.
              if (last && last.until > now) await this.watches.update({ id: last.id }, { until: now });
              await this.watches.save(
                this.watches.create({
                  accountId: account.id,
                  problemId: problem.id,
                  contestId: contest?.id || 0,
                  contestProblemIndex: request.contestProblemIndex || 0,
                  startedAt: now,
                  until
                })
              );
            }
            return !last;
          });
          // Register context before waiting for a long history worker: the user can submit immediately.
          if (platform === SubmissionMethod.Codeforces && firstVisit && account.cursor !== "0")
            await this.lockService.lock(`RemoteAccount_${account.id}`, async () => {
              const current = await this.accounts.findOneBy({ id: account.id });
              if (current) await this.accounts.update({ id: account.id }, { cursor: "0", scan: null });
            });
        }
      }
    } else if (request.contestId || request.contestProblemIndex) throw new BadRequestException("PROBLEM_REQUIRED");
    const accounts = await this.accounts.findBy({ userId: user.id, ...(platform ? { platform } : {}) });
    for (const account of accounts) {
      // A refresh cannot bypass the upstream sync cooldown or reset history pagination.
      await this.accounts.update(
        { id: account.id },
        {
          catchUpRequested: true,
          catchUpVersion: () => "catchUpVersion + 1",
          ...(request.problemId ? { activeUntil: new Date(Date.now() + this.settings.activeMinutes * 60000) } : {})
        }
      );
    }
    return await this.list(user);
  }

  async status(user: UserEntity, request: RemoteContextDto) {
    const { problem, contest } = await this.context(user, request);
    const account = await this.accounts.findOneBy({ userId: user.id, platform: problem.submissionMethod });
    const latest = await this.connection
      .getRepository(SubmissionEntity)
      .createQueryBuilder("submission")
      .where("submission.submitterId = :userId AND submission.problemId = :problemId", {
        userId: user.id,
        problemId: problem.id
      })
      .andWhere(request.contestId ? "submission.contestId = :contestId" : "submission.contestId IS NULL", {
        contestId: request.contestId
      })
      .andWhere("submission.remoteKey IS NOT NULL")
      .orderBy("submission.submitTime", "DESC")
      .addOrderBy("submission.id", "DESC")
      .getOne();
    const hideResult = contest && (await this.contests.shouldHideNoiResult(user, contest));
    return {
      enabled: this.settings.enabled,
      bound: !!account,
      handle: account?.handle,
      lastSyncedAt: account?.lastSyncedAt,
      lastError: account?.lastError,
      latest: latest
        ? {
            id: latest.id,
            status: hideResult ? "Submitted" : latest.status,
            submittedAt: latest.submitTime,
            remote: hideResult ? undefined : latest.remote
          }
        : null
    };
  }

  async setMethod(user: UserEntity, request: SetSubmissionMethodDto) {
    const problem = await this.problems.findProblemById(request.problemId);
    if (!problem) throw new BadRequestException("NO_SUCH_PROBLEM");
    if (!(await this.problems.userHasPermission(user, problem, ProblemPermissionType.Modify)))
      throw new ForbiddenException();
    let source;
    try {
      source = parseRemoteProblem(request.submissionMethod, request.remoteUrl);
    } catch {
      throw new BadRequestException("INVALID_REMOTE_URL");
    }
    if (source && request.remoteFullScore) source.fullScore = request.remoteFullScore;
    await this.problems.lockProblemById(problem.id, "Write", async locked => {
      if (!locked) throw new BadRequestException("NO_SUCH_PROBLEM");
      if (source && locked.type === ProblemType.SubmitAnswer)
        throw new BadRequestException("REMOTE_SUBMIT_ANSWER_UNSUPPORTED");
      if (source && (await this.connection.getRepository(ProblemFileEntity).countBy({ problemId: problem.id })))
        throw new BadRequestException("REMOVE_FILES_FIRST");
      if (
        await this.connection
          .getRepository(SubmissionEntity)
          .countBy({ problemId: problem.id, status: SubmissionStatus.Pending })
      )
        throw new BadRequestException("PENDING_SUBMISSIONS");
      const changed =
        locked.submissionMethod !== request.submissionMethod ||
        locked.remoteProblem?.contestId !== source?.contestId ||
        locked.remoteProblem?.taskId !== source?.taskId;
      await this.connection.transaction(async manager => {
        if (changed) await manager.delete(RemoteWatchEntity, { problemId: problem.id });
        await manager.update(
          ProblemEntity,
          { id: problem.id },
          {
            submissionMethod: request.submissionMethod,
            remoteProblem: source,
            remoteProblemKey: source ? `${source.contestId}:${source.taskId}` : null
          }
        );
        if (request.submittable != null)
          await manager.update(ProblemJudgeInfoEntity, { problemId: problem.id }, { submittable: request.submittable });
      });
    });
    await this.audit.log("problem.set_submission_method", AuditLogObjectType.Problem, problem.id, {
      oldMethod: problem.submissionMethod,
      oldSource: problem.remoteProblem,
      newMethod: request.submissionMethod,
      newSource: source,
      submittable: request.submittable
    });
    return {};
  }

  private async importResult(
    account: RemoteAccountEntity,
    user: UserEntity,
    row: RemoteSubmission,
    problems: ProblemEntity[],
    watches: RemoteWatchEntity[]
  ) {
    if (!Number.isSafeInteger(row.submittedAt) || row.submittedAt <= 0 || row.submittedAt > Date.now() / 1000 + 60) {
      for (const problem of problems)
        if (problem.remoteProblem?.contestId === row.contestId && problem.remoteProblem?.taskId === row.taskId)
          this.monitor?.finishProblem(account.platform, problem.id, false);
      return;
    }
    for (const candidate of problems) {
      if (candidate.remoteProblem?.contestId !== row.contestId || candidate.remoteProblem?.taskId !== row.taskId)
        continue;
      let synchronized = false;
      this.monitor?.beginProblem(account.platform, candidate.id);
      await this.problems.lockProblemById(candidate.id, "Read", async problem => {
        if (
          !problem ||
          problem.submissionMethod !== account.platform ||
          problem.remoteProblem?.contestId !== row.contestId ||
          problem.remoteProblem?.taskId !== row.taskId
        )
          return;
        const [, submittable] = await this.problems.getProblemJudgeInfo(problem);
        if (!submittable) return;
        const normalizedStatus =
          row.status === SubmissionStatus.WrongAnswer && row.points > 0 && problem.remoteProblem.fullScore
            ? SubmissionStatus.PartiallyCorrect
            : row.status;
        const remote = {
          ...row,
          status: normalizedStatus,
          platform: account.platform,
          handle: account.handle,
          historical: row.submittedAt * 1000 < +account.verifiedAt
        };
        const restricted = await this.contests.getContestAccessRestriction(user);
        // One original submission creates one NSOJ record per problem, even when watched in a contest.
        // The most recently selected valid contest owns the submission, as with a local submit form.
        let contestContext;
        const matchingWatches = watches
          .filter(
            item =>
              item.contestId > 0 &&
              item.problemId === problem.id &&
              +item.startedAt <= row.submittedAt * 1000 &&
              row.submittedAt * 1000 < +item.until
          )
          .sort((a, b) => +b.startedAt - +a.startedAt || b.id - a.id);
        for (const watch of matchingWatches) {
          if (restricted.length && !restricted.some(item => item.id === watch.contestId)) continue;
          const contest = await this.contests.findContestById(watch.contestId);
          if (
            !contest ||
            contest.problemIds[watch.contestProblemIndex - 1] !== problem.id ||
            !(await this.contests.userHasPermission(user, contest, ContestPermissionType.View))
          )
            continue;
          const phase = this.contests.getSubmissionPhase(contest, new Date(row.submittedAt * 1000));
          if (!phase) continue;
          contestContext = { id: contest.id, problemIndex: watch.contestProblemIndex, phase };
          break;
        }
        if (
          contestContext ||
          (restricted.length === 0 &&
            (await this.problems.userHasPermission(user, problem, ProblemPermissionType.View)))
        ) {
          synchronized = await this.submissions.importRemoteSubmission(user, problem, remote, contestContext);
        }
      });
      this.monitor?.finishProblem(account.platform, candidate.id, synchronized);
    }
  }

  private async bufferedCodeforcesPage(
    account: RemoteAccountEntity,
    scan: RemoteAccountEntity["scan"],
    source: Pick<RemotePage, "sourceError" | "sourceRetryAt">
  ): Promise<RemotePage> {
    const page = await this.codeforcesImportBuffer.read(account.id, scan.bufferKey);
    return {
      ...page,
      sourceError: source.sourceError,
      sourceRetryAt: source.sourceRetryAt,
      cursor: page.more ? account.cursor : scan.importCursor,
      scan: page.more ? scan : null,
      pending: !!scan.importPending
    };
  }

  private async remoteProblems(platform: SubmissionMethod, submissions: RemoteSubmission[]): Promise<ProblemEntity[]> {
    const sourceKeys = [...new Set(submissions.map(row => `${row.contestId}:${row.taskId}`))];
    return sourceKeys.length
      ? await this.connection.getRepository(ProblemEntity).findBy({
          submissionMethod: platform,
          remoteProblemKey: In(sourceKeys)
        })
      : [];
  }

  private async codeforcesImportPage(account: RemoteAccountEntity): Promise<RemotePage> {
    if (account.scan?.bufferKey && account.scan.importCursor !== undefined)
      return await this.bufferedCodeforcesPage(account, account.scan, {
        sourceError: account.codeforcesSourceError,
        sourceRetryAt: account.codeforcesSourceRetryAt
      });
    // Restart legacy in-flight scans so every page participates in the ordered batch.
    const scan = account.scan?.bufferKey ? account.scan : null;
    const page = await this.provider.getPage({ ...account, scan });
    if (!scan && !page.more) {
      await this.codeforcesImportBuffer.discard(account.id);
      page.submissions.sort((a, b) => a.submittedAt - b.submittedAt || Number(a.id) - Number(b.id));
      return page;
    }
    const bufferKey = scan?.bufferKey || randomBytes(12).toString("hex");
    // Keep only submissions for linked NSOJ problems, rather than staging an account's entire source archive.
    const linkedProblems = await this.remoteProblems(SubmissionMethod.Codeforces, page.submissions);
    const linked = new Set(linkedProblems.map(problem => problem.remoteProblemKey));
    await this.codeforcesImportBuffer.stage(
      account.id,
      bufferKey,
      page.submissions.filter(row => linked.has(`${row.contestId}:${row.taskId}`))
    );
    if (page.more) {
      this.monitor?.setTaskProblems(SubmissionMethod.Codeforces, linkedProblems, page.submissions, "Collecting");
      return { ...page, submissions: [], scan: { ...page.scan, bufferKey } };
    }
    const importScan: RemoteAccountEntity["scan"] = {
      ...scan,
      bufferKey,
      importCursor: page.cursor,
      importPending: page.pending
    };
    this.monitor?.setTaskPhase(SubmissionMethod.Codeforces, "Importing");
    // Persist the collection/import boundary before allocating any submission IDs.
    await page.acknowledge?.();
    await this.accounts.update(
      { id: account.id },
      {
        scan: importScan,
        codeforcesSourceError: page.sourceError || null,
        codeforcesSourceRetryAt: page.sourceRetryAt || null
      }
    );
    return await this.bufferedCodeforcesPage(account, importScan, page);
  }

  private async tick(platform: SubmissionMethod): Promise<void> {
    const now = new Date();
    const candidate = await this.accounts
      .createQueryBuilder("account")
      .where(
        "account.platform = :platform AND account.nextSyncAt <= :now AND (account.activeUntil > :now OR account.catchUpRequested = 1)",
        {
          platform,
          now
        }
      )
      .orderBy("account.nextSyncAt", "ASC")
      .getOne();
    if (!candidate) return;
    const redis = this.redisService.getSharedClient();
    const token = randomBytes(12).toString("hex");
    const claim = `remote-sync-claim:${candidate.id}`;
    if (!(await redis.set(claim, token, "PX", 120000, "NX"))) return;
    try {
      await this.lockService.lock(`RemoteAccount_${candidate.id}`, async () => {
        const account = await this.accounts.findOneBy({ id: candidate.id });
        if (!account || account.nextSyncAt > new Date() || !this.settings.enabled) return;
        this.monitor?.startTask(
          platform,
          account.id,
          platform === SubmissionMethod.Codeforces && account.scan?.importCursor !== undefined
            ? "Importing"
            : platform === SubmissionMethod.Codeforces && (account.scan || account.cursor === "0")
            ? "Collecting"
            : "Syncing"
        );
        const outcome: RemoteTaskOutcome = {
          state: "Skipped",
          continuation: "None",
          processed: 0,
          nextSyncAt: null,
          error: null,
          sourceError: null
        };
        try {
          const user = await this.users.findUserById(account.userId);
          if (!user?.isActive) {
            await this.accounts.update({ id: account.id }, { activeUntil: new Date(0), catchUpRequested: false });
            outcome.continuation = "Inactive";
            return;
          }
          if (platform === SubmissionMethod.Codeforces && account.codeforcesSummaryVersion === 0) {
            // Existing accounts backfill summaries once on their next active sync.
            await this.accounts.update({ id: account.id }, { codeforcesSummaryVersion: 1, cursor: "0", scan: null });
            Object.assign(account, { codeforcesSummaryVersion: 1, cursor: "0", scan: null });
          }
          let watches: RemoteWatchEntity[];
          const liveTargets = new Map<string, AtcoderLiveTarget>();
          if (platform === SubmissionMethod.AtCoder) {
            // Keep the account due while paused so a newly saved session takes effect on the next turn.
            if (!(await this.provider.hasAtcoderDirectSession())) {
              outcome.continuation = "Paused";
              return;
            }
            watches = await this.watches.findBy({ accountId: account.id });
            const recent = watches.filter(watch => +watch.until >= Date.now() - 86400000);
            const ids = [...new Set(recent.map(watch => watch.problemId))];
            const watchedProblems = ids.length
              ? await this.connection.getRepository(ProblemEntity).findBy({ id: In(ids), submissionMethod: platform })
              : [];
            for (const problem of watchedProblems) {
              if (!problem.remoteProblem) continue;
              const { contestId } = problem.remoteProblem;
              const since = Math.floor(
                Math.min(...recent.filter(watch => watch.problemId === problem.id).map(watch => +watch.startedAt)) /
                  1000
              );
              const previous = liveTargets.get(contestId);
              liveTargets.set(contestId, { contestId, since: Math.min(previous?.since ?? since, since) });
            }
          }
          const page =
            platform === SubmissionMethod.Codeforces
              ? await this.codeforcesImportPage(account)
              : await this.provider.getPage(account, [...liveTargets.values()]);
          const problems = await this.remoteProblems(platform, page.submissions);
          if (page.submissions.length) this.monitor?.setTaskProblems(platform, problems, page.submissions);
          watches ??= await this.watches.findBy({ accountId: account.id });
          if (page.submissions.length) this.monitor?.setTaskPhase(platform, "Importing");
          for (const row of page.submissions) {
            await this.importResult(account, user, row, problems, watches);
            outcome.processed++;
          }
          await page.acknowledge?.();
          const nextSyncAt = new Date(Date.now() + (page.more ? 1000 : this.settings.intervalSeconds * 1000));
          await this.accounts.update(
            { id: account.id },
            {
              cursor: page.cursor,
              scan: page.scan,
              lastSyncedAt: new Date(),
              lastError: null,
              lastErrorAt: null,
              failures: 0,
              ...(platform === SubmissionMethod.Codeforces
                ? {
                    codeforcesSourceError: page.sourceError || null,
                    codeforcesSourceRetryAt: page.sourceRetryAt || null
                  }
                : {}),
              nextSyncAt,
              // A return-to-site request arriving during this sync must survive its completion.
              catchUpRequested:
                page.more || page.pending
                  ? true
                  : () => `IF(catchUpVersion = ${Number(account.catchUpVersion) || 0}, 0, 1)`
            }
          );
          Object.assign(outcome, {
            state: "Succeeded",
            continuation: page.more
              ? "More"
              : page.pending
              ? "Pending"
              : +account.activeUntil > Date.now()
              ? "Polling"
              : "None",
            nextSyncAt: nextSyncAt.toISOString(),
            sourceError: page.sourceError || null
          });
        } catch (error) {
          const failures = account.failures + 1;
          const nextSyncAt = new Date(
            Date.now() + Math.min(3600000, this.settings.intervalSeconds * 1000 * 2 ** Math.min(failures, 7))
          );
          Object.assign(outcome, {
            state: "Failed",
            continuation: "Retry",
            nextSyncAt: nextSyncAt.toISOString(),
            error: /^REMOTE_[A-Z_]+$/.test(error.message) ? error.message : "REMOTE_SYNC_FAILED"
          });
          await this.accounts.update(
            { id: account.id },
            {
              failures,
              lastError: /^REMOTE_[A-Z_]+$/.test(error.message) ? error.message : "REMOTE_SYNC_FAILED",
              lastErrorAt: new Date(),
              nextSyncAt
            }
          );
          logger.warn(
            `Remote sync ${platform} account ${account.id}: ${
              /^REMOTE_[A-Z_]+$/.test(error.message) ? error.message : "REMOTE_SYNC_FAILED"
            }`
          );
        } finally {
          this.monitor?.finishTask(platform, outcome);
        }
      });
    } finally {
      await redis.eval(
        "if redis.call('get',KEYS[1]) == ARGV[1] then return redis.call('del',KEYS[1]) end return 0",
        1,
        claim,
        token
      );
    }
  }
}
