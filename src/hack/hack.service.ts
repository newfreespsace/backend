import { createHash, randomUUID } from "crypto";

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit
} from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";

import { DataSource, EntityManager, In, IsNull, LessThan, LessThanOrEqual, MoreThan } from "typeorm";

import { CodeLanguageService } from "@/code-language/code-language.service";
import { ConfigService } from "@/config/config.service";
import { ContestEntity, ContestType } from "@/contest/contest.entity";
import { ContestPermissionType, ContestService, OFFICIAL_RANKLIST_REVIEW_SECONDS } from "@/contest/contest.service";
import { FileService } from "@/file/file.service";
import { JudgeQueueService } from "@/judge/judge-queue.service";
import { logger } from "@/logger";
import { ProblemJudgeInfoTraditional } from "@/problem-type/types/traditional/problem-judge-info.interface";
import { SubmissionContentTraditional } from "@/problem-type/types/traditional/submission-content.interface";
import { ProblemEntity, ProblemType } from "@/problem/problem.entity";
import { ProblemFileType } from "@/problem/problem-file.entity";
import { ProblemPermissionType, ProblemService } from "@/problem/problem.service";
import { localDateKey, TestdataQuotaService } from "@/problem/testdata-quota.service";
import { LockService } from "@/redis/lock.service";
import { SubmissionMethod } from "@/remote-judge/remote-judge.types";
import { SubmissionDetailEntity } from "@/submission/submission-detail.entity";
import { SubmissionProgressType } from "@/submission/submission-progress.interface";
import { SubmissionStatus } from "@/submission/submission-status.enum";
import { ContestSubmissionPhase, SubmissionEntity } from "@/submission/submission.entity";
import { SubmissionPermissionType, SubmissionService } from "@/submission/submission.service";
import { UserEntity } from "@/user/user.entity";

import { HackAttemptEntity, HackState, ProblemHackProfileEntity } from "./hack.entity";
import {
  HACK_DAILY_LIMIT,
  HACK_INPUT_DEFAULT,
  HACK_OUTPUT_MAX,
  HackDispatcher,
  HackReport,
  HackSnapshot,
  HackTask
} from "./hack.types";

const pending = [HackState.Queued, HackState.Running];
const failureVerdicts = new Set([
  SubmissionStatus.WrongAnswer,
  SubmissionStatus.RuntimeError,
  SubmissionStatus.TimeLimitExceeded,
  SubmissionStatus.MemoryLimitExceeded,
  SubmissionStatus.OutputLimitExceeded,
  SubmissionStatus.FileError
]);
const LEASE_MS = 60_000;
const DEADLINE_MS = 240_000;
const MAX_RUNS = 3;
const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;

const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

function isOfficialContestSubmission(submission: SubmissionEntity) {
  return submission.contestId && submission.contestPhase !== ContestSubmissionPhase.PostContest;
}

function scoreAfterHack(regularScore: number, contestType?: ContestType): number {
  return contestType === ContestType.ACM ? 0 : regularScore;
}

@Injectable()
export class HackService implements OnModuleInit, OnModuleDestroy, HackDispatcher {
  private timer: ReturnType<typeof setInterval>;

  private sweeping = false;

  private nextCleanupAt = 0;

  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly problems: ProblemService,
    private readonly submissions: SubmissionService,
    private readonly contests: ContestService,
    private readonly languages: CodeLanguageService,
    private readonly files: FileService,
    private readonly locks: LockService,
    private readonly queue: JudgeQueueService,
    private readonly quota: TestdataQuotaService,
    private readonly config: ConfigService
  ) {}

  private get attempts() {
    return this.db.getRepository(HackAttemptEntity);
  }

  private get profiles() {
    return this.db.getRepository(ProblemHackProfileEntity);
  }

  onModuleInit() {
    this.queue.hackDispatcher = this;
    this.timer = setInterval(() => {
      if (this.sweeping) return;
      this.sweeping = true;
      this.maintain()
        .catch(() => logger.warn("Hack maintenance failed"))
        .finally(() => {
          this.sweeping = false;
        });
    }, 5000);
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
    if (this.queue.hackDispatcher === this) this.queue.hackDispatcher = undefined;
  }

  private async checkContext(
    user: UserEntity,
    problem: ProblemEntity,
    contestId?: number,
    contestProblemIndex?: number
  ) {
    if (!user || !problem) return false;
    if ((await this.contests.getContestAccessRestriction(user)).length) return false;
    if (!contestId) return await this.problems.userHasPermission(user, problem, ProblemPermissionType.View);
    const contest = await this.contests.findContestById(contestId);
    return (
      !!contest &&
      this.contests.isEnded(contest) &&
      (contestProblemIndex === undefined
        ? contest.problemIds.includes(problem.id)
        : contest.problemIds[contestProblemIndex - 1] === problem.id) &&
      (await this.contests.userHasPermission(user, contest, ContestPermissionType.View))
    );
  }

  private localTraditional(problem: ProblemEntity) {
    return (
      problem?.type === ProblemType.Traditional &&
      (!problem.submissionMethod || problem.submissionMethod === SubmissionMethod.Local)
    );
  }

  private async enabledProfile(problem: ProblemEntity) {
    return this.localTraditional(problem) && (await this.profiles.findOneBy({ problemId: problem.id, enabled: true }));
  }

  private async isLocalTargetInContext(user: UserEntity, target: SubmissionEntity, problem: ProblemEntity) {
    return (
      !!target &&
      !target.remote &&
      !target.remoteKey &&
      (await this.checkContext(user, problem, target.contestId, target.contestProblemIndex ?? 0))
    );
  }

  private async canManage(user: UserEntity, target: SubmissionEntity, problem: ProblemEntity) {
    if (!(await this.checkContext(user, problem, target.contestId))) return false;
    if (!target.contestId) return await this.problems.userHasPermission(user, problem, ProblemPermissionType.Modify);
    const contest = await this.contests.findContestById(target.contestId);
    return !!contest && (await this.contests.userHasPermission(user, contest, ContestPermissionType.Manage));
  }

  async getProfile(user: UserEntity, problemId: number) {
    const problem = await this.problems.findProblemById(problemId);
    if (
      !this.localTraditional(problem) ||
      !(await this.problems.userHasPermission(user, problem, ProblemPermissionType.Modify))
    ) {
      throw new ForbiddenException();
    }
    return (
      (await this.profiles.findOneBy({ problemId })) ?? { problemId, enabled: false, inputLimit: HACK_INPUT_DEFAULT }
    );
  }

  async saveProfile(user: UserEntity, update: ProblemHackProfileEntity) {
    await this.getProfile(user, update.problemId);
    if (update.enabled && (!update.validator || !update.reference))
      throw new BadRequestException("HACK_CONFIGURATION_INCOMPLETE");
    for (const program of [update.validator, update.reference].filter(Boolean)) {
      if (this.languages.validateCompileAndRunOptions(program.language, program.compileAndRunOptions).length) {
        throw new BadRequestException("HACK_PROGRAM_OPTIONS_INVALID");
      }
    }
    await this.profiles.save({ ...update, validator: update.validator ?? null, reference: update.reference ?? null });
    return { success: true };
  }

  async targets(user: UserEntity, problemId: number, contestId?: number, before?: number) {
    const problem = await this.problems.findProblemById(problemId);
    if (!(await this.checkContext(user, problem, contestId))) throw new ForbiddenException();
    const profile = await this.enabledProfile(problem);
    if (!profile) return { enabled: false, targets: [] };
    if (!(await this.submissions.canViewOtherSubmissions(user, undefined, problemId))) {
      return { enabled: true, inputLimit: profile.inputLimit, targets: [] };
    }

    const candidates = this.db
      .getRepository(SubmissionEntity)
      .createQueryBuilder("submission")
      .where("submission.problemId = :problemId AND submission.status = :status", {
        problemId,
        status: SubmissionStatus.Accepted
      })
      .andWhere("submission.remoteKey IS NULL AND submission.remote IS NULL AND submission.taskId IS NULL")
      .orderBy("submission.id", "DESC")
      .take(30);
    if (contestId) candidates.andWhere("submission.contestId = :contestId", { contestId });
    else candidates.andWhere("submission.contestId IS NULL");
    if (before) candidates.andWhere("submission.id < :before", { before });
    const rows = await candidates.getMany();
    return {
      enabled: true,
      inputLimit: profile.inputLimit,
      targets: rows.map(row => ({ id: row.id, language: row.codeLanguage, time: row.submitTime }))
    };
  }

  async target(user: UserEntity, id: number, contestId?: number) {
    if (!user) return null;
    const target = await this.submissions.findSubmissionById(id);
    if (
      !target ||
      (target.contestId ?? null) !== (contestId ?? null) ||
      target.status !== SubmissionStatus.Accepted ||
      target.taskId
    ) {
      return null;
    }
    const problem = await this.problems.findProblemById(target.problemId);
    if (!(await this.isLocalTargetInContext(user, target, problem))) return null;
    if (!(await this.submissions.canViewOtherSubmissions(user, undefined, problem.id))) return null;
    const profile = await this.enabledProfile(problem);
    return profile
      ? { id: target.id, language: target.codeLanguage, time: target.submitTime, inputLimit: profile.inputLimit }
      : null;
  }

  private async snapshot(
    problem: ProblemEntity,
    profile: ProblemHackProfileEntity,
    language: string
  ): Promise<HackSnapshot> {
    const [raw, submittable] = await this.problems.getProblemPreprocessedJudgeInfo(problem);
    const info = raw as ProblemJudgeInfoTraditional;
    if (!submittable || !info?.checker || !profile.validator || !profile.reference) {
      throw new ConflictException("HACK_CONFIGURATION_INCOMPLETE");
    }
    const filenames = new Set(
      Object.values(info.extraSourceFiles?.[language as keyof typeof info.extraSourceFiles] || {})
    );
    if (info.checker.type === "custom") filenames.add(info.checker.filename);
    const files = filenames.size ? await this.problems.getProblemFiles(problem, ProblemFileType.TestData) : [];
    const testData: Record<string, string> = {};
    const artifacts: Record<string, string> = {};
    let remaining = MAX_ARTIFACT_BYTES;
    // Limit the total buffered snapshot across every referenced file.
    /* eslint-disable no-await-in-loop */
    for (const filename of [...filenames].sort()) {
      const file = files.find(item => item.filename === filename);
      if (!file) throw new ConflictException("HACK_CONFIGURATION_INCOMPLETE");
      const stream = await this.files.getFileStream(file.uuid);
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        remaining -= bytes.length;
        if (remaining < 0) throw new ConflictException("HACK_CONFIGURATION_TOO_LARGE");
        chunks.push(bytes);
      }
      const bytes = Buffer.concat(chunks);
      const id = `hack-${hash(bytes)}`;
      artifacts[id] = bytes.toString("base64");
      Object.defineProperty(testData, filename, { value: id, enumerable: true });
    }
    /* eslint-enable no-await-in-loop */
    const { fileIo, checker, timeLimit, memoryLimit } = info;
    if (timeLimit <= 0 || timeLimit > 30000 || memoryLimit <= 0)
      throw new ConflictException("HACK_CONFIGURATION_INCOMPLETE");
    return {
      judgeInfo: { fileIo, checker, timeLimit, memoryLimit, extraSourceFiles: info.extraSourceFiles },
      validator: profile.validator,
      reference: profile.reference,
      testData,
      artifacts
    };
  }

  async create(user: UserEntity, targetId: number, text: string) {
    if (!user) throw new ForbiddenException();
    const initial = await this.submissions.findSubmissionById(targetId);
    if (!initial) throw new NotFoundException();
    return await this.locks.lock(`HackUser_${user.id}`, () =>
      this.submissions.lockSubmission(initial, true, async (target, problem) => {
        if (!(await this.isLocalTargetInContext(user, target, problem))) throw new NotFoundException();
        const canChallenge = await this.submissions.canViewOtherSubmissions(user, undefined, problem.id);
        const input = Buffer.from(text, "utf8");
        const inputHash = hash(input);
        const base = { challengerId: user.id, targetSubmissionId: target.id, inputHash };
        if (!canChallenge || target.status !== SubmissionStatus.Accepted || target.taskId) {
          const existing = await this.attempts.findOne({ where: base, order: { id: "DESC" } });
          if (existing) return this.metadata(existing, user, false);
          if (!canChallenge) throw new NotFoundException();
          throw new ConflictException("HACK_TARGET_NOT_ACCEPTED");
        }
        const profile = await this.enabledProfile(problem);
        if (!profile) throw new ConflictException("HACK_DISABLED");
        if (input.toString("utf8") !== text || input.length > profile.inputLimit)
          throw new BadRequestException("HACK_INPUT_INVALID");
        const snapshot = await this.snapshot(problem, profile, target.codeLanguage);
        const quotaDay = localDateKey();
        const unique = {
          ...base,
          snapshotHash: hash(JSON.stringify(snapshot)),
          targetRevision: target.judgeResultRevision ?? "legacy"
        };
        const created = await this.db.transaction(async manager => {
          // The account row serializes admission across backend replicas and quota days.
          await manager.findOne(UserEntity, { where: { id: user.id }, lock: { mode: "pessimistic_write" } });
          const repository = manager.getRepository(HackAttemptEntity);
          const duplicate = await repository.findOneBy(unique);
          if (duplicate) return duplicate;
          if (await repository.countBy({ challengerId: user.id, state: In(pending), replay: false })) {
            throw new ConflictException("HACK_ALREADY_PENDING");
          }
          if ((await repository.countBy({ challengerId: user.id, quotaDay, charged: true })) >= HACK_DAILY_LIMIT) {
            throw new ConflictException("HACK_DAILY_LIMIT");
          }
          // Seal only after every admission that took its timestamp before the cutoff has committed.
          if (isOfficialContestSubmission(target)) {
            await manager.findOne(ContestEntity, {
              where: { id: target.contestId },
              lock: { mode: "pessimistic_read" }
            });
          }
          return await repository.save(
            repository.create({
              ...unique,
              problemId: problem.id,
              contestId: target.contestId,
              targetUserId: target.submitterId,
              snapshot,
              input,
              quotaDay,
              state: HackState.Queued,
              createdAt: new Date()
            })
          );
        });
        return this.metadata(created, user, false);
      })
    );
  }

  private loadTaskRow(manager: EntityManager = this.db.manager) {
    return manager
      .getRepository(HackAttemptEntity)
      .createQueryBuilder("hack")
      .addSelect(["hack.snapshot", "hack.input", "hack.output", "hack.regularResult"]);
  }

  async claim(worker: string): Promise<HackTask | null> {
    return await this.locks.lock("HackClaim", async () => {
      const now = new Date();
      const running = await this.attempts.countBy({ state: HackState.Running, leaseUntil: MoreThan(now) });
      if (running >= this.config.config.resourceLimit.hackConcurrentTasks) return null;
      const claim = await this.db.transaction(async manager => {
        const candidates = this.loadTaskRow(manager);
        const waitingForOfficialRanklist = candidates
          .subQuery()
          .select("1")
          .from(ContestEntity, "contest")
          .innerJoin(SubmissionEntity, "target", "target.id = hack.targetSubmissionId")
          .where("contest.id = hack.contestId AND contest.officialRanklist IS NULL")
          .andWhere("(target.contestPhase IS NULL OR target.contestPhase = :officialPhase)")
          .andWhere("hack.createdAt >= TIMESTAMPADD(SECOND, :reviewSeconds, contest.endTime)");
        const row = await candidates
          .where("(hack.state = :queued OR (hack.state = :running AND hack.leaseUntil <= :now)) AND hack.runs < :max", {
            queued: HackState.Queued,
            running: HackState.Running,
            now,
            max: MAX_RUNS
          })
          .andWhere(`NOT EXISTS ${waitingForOfficialRanklist.getQuery()}`, {
            officialPhase: ContestSubmissionPhase.Official,
            reviewSeconds: OFFICIAL_RANKLIST_REVIEW_SECONDS
          })
          .orderBy("hack.id", "ASC")
          .setLock("pessimistic_write")
          .getOne();
        if (!row) return null;
        const target = await manager.findOneBy(SubmissionEntity, { id: row.targetSubmissionId });
        const detail = target && (await manager.findOneBy(SubmissionDetailEntity, { submissionId: target.id }));
        if (!target || !detail || !row.input || !this.matches(row, target)) {
          row.state = HackState.Obsolete;
          row.finishedAt = now;
          row.taskId = null;
          await manager.save(row);
          return null;
        }
        row.state = HackState.Running;
        row.worker = worker;
        row.taskId = randomUUID();
        row.leaseUntil = new Date(+now + LEASE_MS);
        row.deadline = new Date(+now + DEADLINE_MS);
        row.runs++;
        await manager.save(row);
        return { row, target: detail.content as SubmissionContentTraditional };
      });
      if (!claim) return null;
      const { row, target } = claim;
      return {
        taskId: row.taskId,
        snapshot: row.snapshot,
        input: row.input,
        referenceOutput: row.replay ? row.output : undefined,
        target,
        outputLimit: HACK_OUTPUT_MAX
      };
    });
  }

  private matches(row: HackAttemptEntity, target: SubmissionEntity) {
    return (
      row.targetRevision === (target.judgeResultRevision ?? "legacy") &&
      (row.replay
        ? target.status === SubmissionStatus.Pending
        : !target.taskId && target.status === SubmissionStatus.Accepted)
    );
  }

  async heartbeat(worker: string, taskId: string) {
    const now = new Date();
    const updated = await this.attempts
      .createQueryBuilder()
      .update()
      .set({ leaseUntil: () => "LEAST(deadline, :lease)" })
      .where({ taskId, worker, state: HackState.Running, leaseUntil: MoreThan(now), deadline: MoreThan(now) })
      .setParameter("lease", new Date(+now + LEASE_MS))
      .execute();
    return updated.affected === 1;
  }

  async finish(worker: string, taskId: string, report: HackReport, expired = false) {
    if (!report || !["Succeeded", "Failed", "InvalidInput", "JudgeError"].includes(report.outcome)) return false;
    if (report.outcome === "Succeeded" && !failureVerdicts.has(report.verdict)) return false;
    if (
      ["Succeeded", "Failed"].includes(report.outcome) &&
      (!Buffer.isBuffer(report.output) || report.output.length > HACK_OUTPUT_MAX)
    ) {
      return false;
    }
    const initial = await this.attempts.findOneBy({ worker, taskId });
    if (!initial) return false;
    if (initial.state !== HackState.Running) return true;
    const target = await this.submissions.findSubmissionById(initial.targetSubmissionId);
    if (!target) {
      await this.attempts.update(
        { id: initial.id, taskId, state: HackState.Running },
        { state: HackState.Obsolete, replay: false, finishedAt: new Date() }
      );
      return false;
    }
    return await this.submissions.lockSubmission(target, true, async (current, problem) => {
      if (!current || !problem) return false;
      return await this.lockAcceptedCount(current, () =>
        this.db.transaction(async manager => {
          const row = await this.loadTaskRow(manager)
            .where("hack.taskId = :taskId AND hack.worker = :worker", { taskId, worker })
            .setLock("pessimistic_write")
            .getOne();
          if (!row) return false;
          if (row.state !== HackState.Running) return true;
          if (+row.leaseUntil <= Date.now() !== expired) return false;
          const contest = current.contestId && (await manager.findOneBy(ContestEntity, { id: current.contestId }));
          if (!this.matches(row, current)) {
            row.state = HackState.Obsolete;
          } else if (
            contest &&
            !contest.officialRanklist &&
            isOfficialContestSubmission(current) &&
            row.createdAt >= this.contests.getOfficialRanklistReviewEnd(contest)
          ) {
            // A task leased before this rule was deployed may still report after the cutoff.
            row.state = HackState.Queued;
            row.taskId = null;
            row.worker = null;
            row.leaseUntil = null;
            row.runs--;
            await manager.save(row);
            return true;
          } else if (report.outcome === "JudgeError" && row.runs < MAX_RUNS) {
            row.state = HackState.Queued;
            row.taskId = null;
            row.worker = null;
            row.leaseUntil = null;
            await manager.save(row);
            return true;
          } else if (row.replay) {
            await this.completeReplay(manager, row, current, report, contest ? contest.type : undefined);
          } else {
            row.state = HackState[report.outcome];
            row.verdict = report.verdict ?? null;
            row.output = report.output ?? null;
            if (row.state === HackState.Succeeded) {
              const detail = await manager.findOneBy(SubmissionDetailEntity, { submissionId: current.id });
              row.regularResult = detail.result;
              row.effectiveScore = scoreAfterHack(current.score, contest ? contest.type : undefined);
              await this.submissions.storeHackResult(manager, current, {
                ...detail.result,
                progressType: SubmissionProgressType.Finished,
                status: row.verdict,
                score: row.effectiveScore
              });
              row.needsRefresh = true;
              row.refreshRevision = current.judgeResultRevision;
            }
          }
          row.finishedAt = new Date();
          if (row.state === HackState.JudgeError) row.charged = false;
          await manager.save(row);
          return true;
        })
      );
    });
  }

  private async completeReplay(
    manager: EntityManager,
    row: HackAttemptEntity,
    target: SubmissionEntity,
    report: HackReport,
    contestType?: ContestType
  ) {
    const detail = await manager.findOneBy(SubmissionDetailEntity, { submissionId: target.id });
    const regular = detail.result;
    const verdict = report.outcome === "Succeeded" ? report.verdict : row.verdict;
    const retainOld = report.outcome === "JudgeError" || report.outcome === "InvalidInput";
    if (!retainOld) {
      row.regularResult = regular;
      row.effectiveScore = report.outcome === "Failed" ? regular.score : scoreAfterHack(regular.score, contestType);
    }
    const result =
      report.outcome === "Failed"
        ? regular
        : {
            ...(retainOld ? row.regularResult ?? regular : regular),
            progressType: SubmissionProgressType.Finished,
            status: verdict,
            // Older successful Hacks used zero, so a failed replay keeps that result too.
            score: row.effectiveScore ?? 0
          };
    await this.submissions.storeHackResult(manager, target, result, !retainOld && report.outcome === "Failed");
    row.state = HackState.Succeeded;
    row.replay = false;
    row.recheckFailed = retainOld;
    row.verdict = verdict;
    row.needsRefresh = true;
    row.refreshRevision = target.judgeResultRevision;
    if (report.outcome === "Failed") {
      row.revokedAt = new Date();
      row.revokeReason = "Recheck passed";
    }
  }

  async cancel(user: UserEntity, id: number) {
    const row = await this.attempts.findOneBy({ id, challengerId: user.id });
    if (!row) throw new NotFoundException();
    const result = await this.attempts.update(
      { id, state: HackState.Queued, replay: false },
      {
        state: HackState.Canceled,
        charged: false,
        finishedAt: new Date()
      }
    );
    if (!result.affected) throw new ConflictException("HACK_ALREADY_RUNNING");
    return { success: true };
  }

  async revoke(user: UserEntity, id: number, reason: string) {
    const row = await this.loadTaskRow().where("hack.id = :id", { id }).getOne();
    const target = row && (await this.submissions.findSubmissionById(row.targetSubmissionId));
    if (!target) throw new NotFoundException();
    return await this.submissions.lockSubmission(target, true, async (current, problem) => {
      if (!current || !(await this.canManage(user, current, problem))) throw new ForbiddenException();
      if (current.taskId) throw new ConflictException("HACK_TARGET_PENDING");
      return await this.lockAcceptedCount(current, () =>
        this.db.transaction(async manager => {
          const stored = await this.loadTaskRow(manager)
            .where("hack.id = :id", { id })
            .setLock("pessimistic_write")
            .getOne();
          if (stored.revokedAt) return { success: true };
          if (stored.state !== HackState.Succeeded || stored.replay || !stored.regularResult) {
            throw new ConflictException("HACK_NOT_SUCCESSFUL");
          }
          const newer = await manager.countBy(HackAttemptEntity, {
            targetSubmissionId: current.id,
            state: HackState.Succeeded,
            revokedAt: IsNull(),
            id: MoreThan(id)
          });
          if (newer) throw new ConflictException("HACK_NEWER_RESULT");
          await this.submissions.storeHackResult(manager, current, stored.regularResult);
          stored.revokedAt = new Date();
          stored.revokedBy = user.id;
          stored.revokeReason = reason;
          stored.needsRefresh = true;
          stored.refreshRevision = current.judgeResultRevision;
          await manager.save(stored);
          return { success: true };
        })
      );
    });
  }

  private metadata(row: HackAttemptEntity, user: UserEntity, manage: boolean, canReadMaterials = false) {
    const mine = row.challengerId === user.id;
    return {
      id: row.id,
      targetSubmissionId: row.targetSubmissionId,
      state: row.replay ? HackState.Succeeded : row.state,
      verdict: row.verdict,
      createdAt: row.createdAt,
      finishedAt: row.finishedAt,
      revokedAt: row.revokedAt,
      recheckFailed: row.recheckFailed,
      challengerId: mine || manage ? row.challengerId : undefined,
      canCancel: mine && row.state === HackState.Queued && !row.replay,
      canDownload:
        canReadMaterials &&
        [HackState.Succeeded, HackState.Failed].includes(row.state) &&
        ((!row.revokedAt && row.state === HackState.Succeeded) ||
          +(row.revokedAt ?? row.finishedAt) + KEEP_MS > Date.now()),
      canRevoke: manage && row.state === HackState.Succeeded && !row.revokedAt
    };
  }

  async targetHistory(user: UserEntity, targetId: number, before?: number) {
    const target = await this.submissions.findSubmissionById(targetId);
    if (!target) throw new NotFoundException();
    const problem = await this.problems.findProblemById(target.problemId);
    if (!(await this.checkContext(user, problem, target.contestId))) throw new NotFoundException();
    const manage = await this.canManage(user, target, problem);
    if (!manage && !(await this.submissions.userHasPermission(user, target, SubmissionPermissionType.View, problem))) {
      throw new NotFoundException();
    }
    const rows = await this.attempts.find({
      where: { targetSubmissionId: targetId, ...(before && { id: LessThan(before) }) },
      order: { id: "DESC" },
      take: 30
    });
    return rows.map(row => this.metadata(row, user, manage, manage || target.submitterId === user.id));
  }

  async mine(user: UserEntity, before?: number, id?: number) {
    if (!user) throw new ForbiddenException();
    const query = this.attempts.createQueryBuilder("hack").where("hack.challengerId = :userId", { userId: user.id });
    if (id) query.andWhere("hack.id = :id", { id }).addSelect("hack.input");
    if (before) query.andWhere("hack.id < :before", { before });
    const rows = await query.orderBy("hack.id", "DESC").take(30).getMany();
    return rows.map(row => ({ ...this.metadata(row, user, false), input: row.input?.toString("utf8") }));
  }

  async download(user: UserEntity, id: number, input: boolean, output: boolean) {
    const row = await this.loadTaskRow().where("hack.id = :id", { id }).getOne();
    if (!row || !row.input || row.output == null || !this.metadata(row, user, false, true).canDownload)
      throw new NotFoundException();
    const target = await this.submissions.findSubmissionById(row.targetSubmissionId);
    const problem = target && (await this.problems.findProblemById(target.problemId));
    if (!target || !(await this.checkContext(user, problem, target.contestId))) throw new NotFoundException();
    if (target.submitterId !== user.id && !(await this.canManage(user, target, problem))) throw new NotFoundException();
    const files = [
      ...(input ? [{ name: `hack-${id}.in`, data: row.input.toString("base64") }] : []),
      ...(output ? [{ name: `hack-${id}.out`, data: row.output.toString("base64") }] : [])
    ];
    if (!files.length) throw new BadRequestException();
    if (await this.problems.userHasPermission(user, problem, ProblemPermissionType.Modify)) return { files };
    const quota = await this.quota.consume(`user:${user.id}`, files.length);
    return quota.allowed
      ? { files, remaining: quota.remaining }
      : { files: [], remaining: quota.remaining, error: "DAILY_DOWNLOAD_LIMIT_EXCEEDED" };
  }

  private async maintain() {
    const now = new Date();
    const expired = await this.attempts.find({
      where: { state: HackState.Running, leaseUntil: LessThanOrEqual(now), runs: MAX_RUNS },
      take: 20
    });
    await Promise.all(
      expired.map(row =>
        row.replay
          ? this.finish(row.worker, row.taskId, { outcome: "JudgeError" }, true)
          : this.attempts.update(
              { id: row.id, taskId: row.taskId, leaseUntil: LessThanOrEqual(now) },
              { state: HackState.JudgeError, charged: false, finishedAt: now }
            )
      )
    );
    const refresh = await this.attempts.find({ where: { needsRefresh: true }, take: 20 });
    await Promise.all(
      refresh.map(row =>
        this.locks.lock(`HackRefresh_${row.id}`, async () => {
          const pendingRefresh = await this.attempts.findOneBy({ id: row.id, needsRefresh: true });
          if (!pendingRefresh) return;
          await this.submissions.refreshHackResult(row.targetSubmissionId);
          await this.attempts.update(
            { id: row.id, refreshRevision: pendingRefresh.refreshRevision },
            { needsRefresh: false }
          );
        })
      )
    );
    await this.contests.finalizeDueOfficialRanklists();
    if (+now < this.nextCleanupAt) return;
    this.nextCleanupAt = +now + 5 * 60 * 1000;
    await this.locks.lock("HackMaterialCleanup", () => this.cleanMaterials(now));
  }

  private async cleanMaterials(now: Date) {
    const cutoff = new Date(+now - KEEP_MS);
    await this.attempts
      .createQueryBuilder()
      .update()
      .set({ revokedAt: now, revokeReason: "Target deleted" })
      .where("state = :succeeded AND revokedAt IS NULL AND targetSubmissionId NOT IN (SELECT id FROM submission)", {
        succeeded: HackState.Succeeded
      })
      .execute();
    await this.attempts
      .createQueryBuilder()
      .update()
      .set({ input: null, output: null, snapshot: null })
      .where("input IS NOT NULL AND ((finishedAt < :cutoff AND state IN (:...states)) OR revokedAt < :cutoff)", {
        cutoff,
        states: [HackState.Failed, HackState.InvalidInput, HackState.Obsolete, HackState.JudgeError, HackState.Canceled]
      })
      .execute();
  }

  private async lockAcceptedCount<T>(submission: SubmissionEntity, callback: () => Promise<T>): Promise<T> {
    const key = `${submission.submitterId}_${submission.problemId}`;
    return await this.locks.lock(`finishAcceptedSubmission_${key}`, () =>
      this.locks.lock(`updateUserAcceptedCount_${key}`, callback)
    );
  }
}
