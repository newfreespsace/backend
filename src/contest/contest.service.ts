import { Inject, Injectable, forwardRef } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";

import { Repository } from "typeorm";

import { Locale } from "@/common/locale.type";
import { ProblemEntity } from "@/problem/problem.entity";
import { ProblemService } from "@/problem/problem.service";
import { SubmissionEntity } from "@/submission/submission.entity";
import { SubmissionStatus } from "@/submission/submission-status.enum";
import { UserEntity } from "@/user/user.entity";
import { UserPrivilegeService, UserPrivilegeType } from "@/user/user-privilege.service";
import { UserService } from "@/user/user.service";

import { ContestEntity, ContestType } from "./contest.entity";
import { ContestPlayerEntity, ContestPlayerScoreDetail } from "./contest-player.entity";
import { ContestMetaDto, ContestProblemDto, ContestRanklistRowDto, SaveContestRequestDto } from "./dto";

export enum ContestPermissionType {
  View = "View",
  Manage = "Manage",
  Create = "Create",
  ViewRanklist = "ViewRanklist",
  ViewStatistics = "ViewStatistics"
}

@Injectable()
export class ContestService {
  constructor(
    @InjectRepository(ContestEntity)
    private readonly contestRepository: Repository<ContestEntity>,
    @InjectRepository(ContestPlayerEntity)
    private readonly contestPlayerRepository: Repository<ContestPlayerEntity>,
    @Inject(forwardRef(() => ProblemService))
    private readonly problemService: ProblemService,
    @Inject(forwardRef(() => UserService))
    private readonly userService: UserService,
    @Inject(forwardRef(() => UserPrivilegeService))
    private readonly userPrivilegeService: UserPrivilegeService
  ) {}

  async findContestById(contestId: number): Promise<ContestEntity> {
    return await this.contestRepository.findOneBy({ id: contestId });
  }

  async userHasPermission(user: UserEntity, contest: ContestEntity, type: ContestPermissionType): Promise<boolean> {
    if (type === ContestPermissionType.Create)
      return !!user && (await this.userPrivilegeService.userHasPrivilege(user, UserPrivilegeType.ManageProblem));

    const manageContest = await this.userPrivilegeService.userHasPrivilege(user, UserPrivilegeType.ManageProblem);
    const manage =
      !!user && (user.isAdmin || manageContest || contest.holderId === user.id || contest.adminIds.includes(user.id));

    switch (type) {
      case ContestPermissionType.View:
        return contest.isPublic || manage;
      case ContestPermissionType.Manage:
        return manage;
      case ContestPermissionType.ViewRanklist:
        return manage || this.isEnded(contest) || (contest.type === ContestType.ACM && this.isRunning(contest));
      case ContestPermissionType.ViewStatistics:
        return manage || this.isEnded(contest) || !contest.hideStatistics;
      default:
        return false;
    }
  }

  async queryContests(
    user: UserEntity,
    skipCount: number,
    takeCount: number,
    nonpublic: boolean
  ): Promise<[ContestEntity[], number]> {
    const canViewNonpublic = await this.userPrivilegeService.userHasPrivilege(user, UserPrivilegeType.ManageProblem);
    if (nonpublic && !canViewNonpublic) return [[], -1];

    const all = await this.contestRepository.find({
      order: {
        startTime: "DESC",
        id: "DESC"
      }
    });
    const visible = all.filter(contest =>
      nonpublic ? !contest.isPublic : contest.isPublic || this.isManagerSync(user, contest)
    );
    return [visible.slice(skipCount, skipCount + takeCount), visible.length];
  }

  private isManagerSync(user: UserEntity, contest: ContestEntity): boolean {
    return !!user && (user.isAdmin || contest.holderId === user.id || contest.adminIds.includes(user.id));
  }

  getContestMeta(contest: ContestEntity): ContestMetaDto {
    return {
      id: contest.id,
      title: contest.title,
      subtitle: contest.subtitle,
      information: contest.information,
      startTime: contest.startTime,
      endTime: contest.endTime,
      type: contest.type,
      isPublic: contest.isPublic,
      hideStatistics: contest.hideStatistics,
      holderId: contest.holderId,
      problemIds: contest.problemIds,
      adminIds: contest.adminIds,
      rankingParams: contest.rankingParams || {}
    };
  }

  isRunning(contest: ContestEntity, now = new Date()): boolean {
    return contest.startTime <= now && now < contest.endTime;
  }

  isEnded(contest: ContestEntity, now = new Date()): boolean {
    return now >= contest.endTime;
  }

  isUnveiled(contest: ContestEntity, user: UserEntity): boolean {
    return this.isManagerSync(user, contest) || new Date() >= contest.startTime;
  }

  async saveContest(
    user: UserEntity,
    request: SaveContestRequestDto
  ): Promise<
    | "PERMISSION_DENIED"
    | "NO_SUCH_CONTEST"
    | "EMPTY_TITLE"
    | "INVALID_TIME_RANGE"
    | "NO_SUCH_PROBLEM"
    | "NO_SUCH_USER"
    | ContestEntity
  > {
    const contest = request.contestId ? await this.findContestById(request.contestId) : new ContestEntity();
    if (request.contestId && !contest) return "NO_SUCH_CONTEST";
    if (
      !request.contestId &&
      !(await this.userHasPermission(user, contest || ({} as ContestEntity), ContestPermissionType.Create))
    )
      return "PERMISSION_DENIED";
    if (request.contestId && !(await this.userHasPermission(user, contest, ContestPermissionType.Manage)))
      return "PERMISSION_DENIED";

    if (!request.title.trim()) return "EMPTY_TITLE";

    const startTime = new Date(request.startTime);
    const endTime = new Date(request.endTime);
    if (!Number.isFinite(startTime.getTime()) || !Number.isFinite(endTime.getTime()) || startTime >= endTime)
      return "INVALID_TIME_RANGE";

    const uniqueProblemIds = Array.from(new Set(request.problemIds.map(Number).filter(Number.isSafeInteger)));
    const problems = await this.problemService.findProblemsByExistingIds(uniqueProblemIds);
    if (problems.some(problem => !problem)) return "NO_SUCH_PROBLEM";

    const uniqueAdminIds = Array.from(new Set(request.adminIds.map(Number).filter(Number.isSafeInteger)));
    const admins = await this.userService.findUsersByExistingIds(uniqueAdminIds);
    if (admins.some(admin => !admin)) return "NO_SUCH_USER";

    contest.title = request.title.trim();
    contest.subtitle = request.subtitle || "";
    contest.information = request.information || "";
    contest.startTime = startTime;
    contest.endTime = endTime;
    contest.type = request.type;
    contest.isPublic = request.isPublic;
    contest.hideStatistics = request.hideStatistics;
    contest.holderId = request.contestId ? contest.holderId : user.id;
    contest.problemIds = uniqueProblemIds;
    contest.adminIds = uniqueAdminIds;
    contest.rankingParams = Object.fromEntries(
      Object.entries(request.rankingParams || {})
        .map(([problemId, multiplier]) => [String(Number(problemId)), Number(multiplier)])
        .filter(([problemId, multiplier]) => Number(problemId) && Number.isFinite(multiplier as number))
    );

    return await this.contestRepository.save(contest);
  }

  async getContestProblems(
    contest: ContestEntity,
    locale: Locale,
    user: UserEntity,
    includeStatistics: boolean
  ): Promise<ContestProblemDto[]> {
    const problems = (await this.problemService.findProblemsByExistingIds(contest.problemIds)).filter(
      problem => problem
    );
    const player = user
      ? await this.contestPlayerRepository.findOneBy({
          contestId: contest.id,
          userId: user.id
        })
      : null;
    const players = includeStatistics ? await this.contestPlayerRepository.findBy({ contestId: contest.id }) : [];

    return await Promise.all(
      problems.map(async problem => {
        const detail = player?.scoreDetails?.[problem.id];
        const result: ContestProblemDto = {
          meta: await this.problemService.getProblemMeta(problem, includeStatistics),
          title: await this.problemService.getProblemLocalizedTitle(
            problem,
            problem.locales.includes(locale) ? locale : problem.locales[0]
          )
        };

        if (detail) {
          result.score = detail.score;
          result.submissionId = detail.submissionId;
          result.accepted = detail.accepted;
          result.unacceptedCount = detail.unacceptedCount;
          result.status = detail.accepted
            ? SubmissionStatus.Accepted
            : detail.score != null
            ? SubmissionStatus.PartiallyCorrect
            : null;
        }

        if (includeStatistics) result.statistics = this.getProblemStatistics(contest, problem, players);
        return result;
      })
    );
  }

  private getProblemStatistics(
    contest: ContestEntity,
    problem: ProblemEntity,
    players: ContestPlayerEntity[]
  ): ContestProblemDto["statistics"] {
    const statistics = {
      attempt: 0,
      accepted: 0,
      partially: contest.type === ContestType.ACM ? undefined : 0
    };

    for (const player of players) {
      const detail = player.scoreDetails?.[problem.id];
      if (!detail) continue;

      statistics.attempt++;
      if (
        (contest.type === ContestType.ACM && detail.accepted) ||
        (contest.type !== ContestType.ACM && detail.score === 100)
      )
        statistics.accepted++;
      if (contest.type !== ContestType.ACM && detail.score > 0) statistics.partially++;
    }

    return statistics;
  }

  async getRanklistRows(contest: ContestEntity, currentUser: UserEntity): Promise<ContestRanklistRowDto[]> {
    const players = await this.contestPlayerRepository.findBy({ contestId: contest.id });
    const rows = await Promise.all(
      players.map(async player => {
        const scoreDetails = { ...player.scoreDetails };
        let score = player.score;
        let timeSpent = player.timeSpent;

        if (contest.type !== ContestType.ACM) {
          score = 0;
          let latest = 0;
          for (const [problemId, detail] of Object.entries(scoreDetails)) {
            const weightedScore = Math.round((detail.score || 0) * (contest.rankingParams?.[problemId] || 1));
            detail.weightedScore = weightedScore;
            score += weightedScore;
            const time = new Date(detail.submissions?.[detail.submissionId]?.time || 0).getTime();
            latest = Math.max(latest, time);
          }
          timeSpent = latest;
        }

        return {
          rank: 0,
          user: await this.userService.getUserMeta(await this.userService.findUserById(player.userId), currentUser),
          score,
          timeSpent,
          scoreDetails
        };
      })
    );

    rows.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      return a.timeSpent - b.timeSpent;
    });
    rows.forEach((row, index) => (row.rank = index + 1));
    return rows;
  }

  async onSubmissionFinished(submission: SubmissionEntity): Promise<void> {
    const contests = await this.contestRepository
      .createQueryBuilder("contest")
      .where("contest.startTime <= :submitTime", { submitTime: submission.submitTime })
      .andWhere("contest.endTime >= :submitTime", { submitTime: submission.submitTime })
      .getMany();

    for (const contest of contests.filter(contest => contest.problemIds.includes(submission.problemId))) {
      await this.updatePlayerScore(contest, submission); // eslint-disable-line no-await-in-loop
    }
  }

  private async updatePlayerScore(contest: ContestEntity, submission: SubmissionEntity): Promise<void> {
    let player = await this.contestPlayerRepository.findOneBy({
      contestId: contest.id,
      userId: submission.submitterId
    });
    if (!player) {
      player = new ContestPlayerEntity();
      player.contestId = contest.id;
      player.userId = submission.submitterId;
      player.score = 0;
      player.timeSpent = 0;
      player.scoreDetails = {};
    }

    const problemId = String(submission.problemId);
    const detail: ContestPlayerScoreDetail = player.scoreDetails[problemId] || {
      submissions: {}
    };
    detail.submissions = detail.submissions || {};
    detail.submissions[submission.id] = {
      submissionId: submission.id,
      score: submission.score,
      accepted: submission.status === SubmissionStatus.Accepted,
      compiled: submission.score != null,
      time: submission.submitTime.toISOString()
    };

    if (contest.type === ContestType.IOI) this.updateIoiDetail(detail);
    else if (contest.type === ContestType.NOI) this.updateNoiDetail(detail, submission);
    else this.updateAcmDetail(detail);

    player.scoreDetails[problemId] = detail;
    this.recalculatePlayerSummary(contest, player);
    await this.contestPlayerRepository.save(player);
  }

  private updateIoiDetail(detail: ContestPlayerScoreDetail): void {
    const submissions = Object.values(detail.submissions).sort(
      (a, b) => new Date(a.time).getTime() - new Date(b.time).getTime()
    );
    const best = submissions.reduce((result, item) => {
      if (!result) return item;
      if ((item.score || 0) >= (result.score || 0) && (result.score || 0) < 100) return item;
      return result;
    }, null);
    detail.submissionId = best.submissionId;
    detail.score = best.score || 0;
  }

  private updateNoiDetail(detail: ContestPlayerScoreDetail, submission: SubmissionEntity): void {
    if (detail.submissionId && detail.submissionId > submission.id) return;
    detail.submissionId = submission.id;
    detail.score = submission.score || 0;
  }

  private updateAcmDetail(detail: ContestPlayerScoreDetail): void {
    const submissions = Object.values(detail.submissions).sort(
      (a, b) => new Date(a.time).getTime() - new Date(b.time).getTime()
    );
    detail.accepted = false;
    detail.unacceptedCount = 0;
    detail.submissionId = submissions[submissions.length - 1].submissionId;
    for (const item of submissions) {
      if (item.accepted) {
        detail.accepted = true;
        detail.acceptedTime = item.time;
        detail.submissionId = item.submissionId;
        break;
      }
      if (item.compiled) detail.unacceptedCount++;
    }
    detail.score = detail.accepted ? 1 : 0;
  }

  private recalculatePlayerSummary(contest: ContestEntity, player: ContestPlayerEntity): void {
    player.score = 0;
    player.timeSpent = 0;
    for (const [problemId, detail] of Object.entries(player.scoreDetails)) {
      if (contest.type === ContestType.ACM) {
        if (detail.accepted) {
          player.score++;
          player.timeSpent +=
            Math.floor((new Date(detail.acceptedTime).getTime() - contest.startTime.getTime()) / 1000) +
            (detail.unacceptedCount || 0) * 20 * 60;
        }
      } else {
        player.score += Math.round((detail.score || 0) * (contest.rankingParams?.[problemId] || 1));
        player.timeSpent = Math.max(
          player.timeSpent,
          new Date(detail.submissions?.[detail.submissionId]?.time || 0).getTime()
        );
      }
    }
  }
}
