import { forwardRef, Inject, Injectable } from "@nestjs/common";

import { InjectRepository } from "@nestjs/typeorm";

import { In, Repository } from "typeorm";

import { Locale } from "@/common/locale.type";
import { ContestEntity } from "@/contest/contest.entity";
import { ContestPermissionType, ContestService } from "@/contest/contest.service";
import { ProblemPermissionType, ProblemService } from "@/problem/problem.service";
import { SubmissionEntity } from "@/submission/submission.entity";
import { SubmissionStatus } from "@/submission/submission-status.enum";
import { UserEntity } from "@/user/user.entity";

import { ProblemReviewEntity } from "./problem-review.entity";
import { PROBLEM_REVIEW_COUNT, PROBLEM_REVIEW_SCHEDULE } from "./problem-review.schedule";

import { CurrentProblemReviewDto, ProblemReviewMetaDto, QueryProblemReviewsResponseDto } from "./dto";

const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;

@Injectable()
export class ProblemReviewService {
  constructor(
    @InjectRepository(ProblemReviewEntity)
    private readonly problemReviewRepository: Repository<ProblemReviewEntity>,
    @InjectRepository(SubmissionEntity)
    private readonly submissionRepository: Repository<SubmissionEntity>,
    @Inject(forwardRef(() => ContestService))
    private readonly contestService: ContestService,
    private readonly problemService: ProblemService
  ) {}

  private calculateReviewWindow(anchor: Date, reviewIndex: number): { availableAt: Date; dueAt: Date } {
    const schedule = PROBLEM_REVIEW_SCHEDULE[reviewIndex];
    return {
      availableAt: new Date(anchor.getTime() + schedule.availableAfterDays * DAY_IN_MILLISECONDS),
      dueAt: new Date(anchor.getTime() + schedule.overdueAfterDays * DAY_IN_MILLISECONDS)
    };
  }

  private getReviewTiming(
    review: ProblemReviewEntity,
    now: Date
  ): Pick<CurrentProblemReviewDto, "overdue" | "overdueDays"> {
    const overdueMilliseconds = now.getTime() - review.dueAt.getTime();
    return {
      overdue: overdueMilliseconds > 0,
      overdueDays: overdueMilliseconds > 0 ? Math.ceil(overdueMilliseconds / DAY_IN_MILLISECONDS) : 0
    };
  }

  async onAcceptedSubmission(submission: SubmissionEntity): Promise<void> {
    const review = await this.problemReviewRepository.findOneBy({
      userId: submission.submitterId,
      problemId: submission.problemId
    });

    if (!review) {
      const firstAcceptedSubmission = await this.submissionRepository.findOne({
        where: {
          submitterId: submission.submitterId,
          problemId: submission.problemId,
          status: SubmissionStatus.Accepted
        },
        order: {
          id: "ASC"
        }
      });

      // Existing accepted problems are intentionally not imported. A plan is only
      // created when this newly accepted submission is the user's first accepted one.
      if (!firstAcceptedSubmission || firstAcceptedSubmission.id !== submission.id) return;

      const now = new Date();
      const window = this.calculateReviewWindow(now, 0);
      const hasContestContext = !!submission.contestId && !!submission.contestProblemIndex;
      const newReview = this.problemReviewRepository.create({
        userId: submission.submitterId,
        problemId: submission.problemId,
        completedReviewCount: 0,
        firstAcceptedSubmissionId: submission.id,
        sourceContestId: hasContestContext ? submission.contestId : null,
        sourceContestProblemIndex: hasContestContext ? submission.contestProblemIndex : null,
        firstAcceptedAt: now,
        lastReviewedAt: null,
        availableAt: window.availableAt,
        dueAt: window.dueAt,
        lastReviewSubmissionId: null,
        completedAt: null,
        createdAt: now,
        updatedAt: now
      });

      await this.problemReviewRepository
        .createQueryBuilder()
        .insert()
        .into(ProblemReviewEntity)
        .values(newReview)
        .orIgnore()
        .execute();
      return;
    }

    if (review.completedReviewCount >= PROBLEM_REVIEW_COUNT) return;
    if (submission.submitTime.getTime() < review.availableAt.getTime()) return;

    const now = new Date();
    const nextCompletedReviewCount = review.completedReviewCount + 1;
    const completed = nextCompletedReviewCount >= PROBLEM_REVIEW_COUNT;
    const nextWindow = completed ? null : this.calculateReviewWindow(now, nextCompletedReviewCount);

    await this.problemReviewRepository
      .createQueryBuilder()
      .update(ProblemReviewEntity)
      .set({
        completedReviewCount: nextCompletedReviewCount,
        lastReviewedAt: now,
        lastReviewSubmissionId: submission.id,
        completedAt: completed ? now : null,
        availableAt: completed ? review.availableAt : nextWindow.availableAt,
        dueAt: completed ? review.dueAt : nextWindow.dueAt,
        updatedAt: now
      })
      .where("id = :id", { id: review.id })
      .andWhere("completedReviewCount = :completedReviewCount", {
        completedReviewCount: review.completedReviewCount
      })
      .execute();
  }

  async getCurrentProblemReview(user: UserEntity, problemId: number): Promise<CurrentProblemReviewDto> {
    if (!user) return null;

    const review = await this.problemReviewRepository.findOneBy({
      userId: user.id,
      problemId
    });
    const now = new Date();
    if (!review || review.completedReviewCount >= PROBLEM_REVIEW_COUNT || review.availableAt.getTime() > now.getTime())
      return null;

    return {
      reviewNumber: review.completedReviewCount + 1,
      totalReviewCount: PROBLEM_REVIEW_COUNT,
      availableAt: review.availableAt,
      dueAt: review.dueAt,
      ...this.getReviewTiming(review, now)
    };
  }

  async queryDueReviews(
    user: UserEntity,
    locale: Locale,
    skipCount: number,
    takeCount: number
  ): Promise<QueryProblemReviewsResponseDto> {
    if (!user)
      return {
        count: 0,
        overdueCount: 0,
        result: []
      };

    const now = new Date();
    const reviews = await this.problemReviewRepository
      .createQueryBuilder("review")
      .where("review.userId = :userId", { userId: user.id })
      .andWhere("review.completedReviewCount < :reviewCount", { reviewCount: PROBLEM_REVIEW_COUNT })
      .andWhere("review.availableAt <= :now", { now })
      .orderBy("review.dueAt", "ASC")
      .getMany();

    const problems = await this.problemService.findProblemsByExistingIds(reviews.map(review => review.problemId));
    const legacySubmissionIds = reviews
      .filter(review => !review.sourceContestId || !review.sourceContestProblemIndex)
      .map(review => review.firstAcceptedSubmissionId);
    const legacySubmissions =
      legacySubmissionIds.length === 0
        ? []
        : await this.submissionRepository.findBy({
            id: In(legacySubmissionIds)
          });
    const legacySubmissionMap = new Map(legacySubmissions.map(submission => [submission.id, submission]));
    const contestMap = new Map<number, Promise<ContestEntity>>();
    const contestPermissionMap = new Map<number, Promise<boolean>>();

    const getContest = (contestId: number): Promise<ContestEntity> => {
      if (!contestMap.has(contestId)) contestMap.set(contestId, this.contestService.findContestById(contestId));
      return contestMap.get(contestId);
    };
    const canViewContest = (contestId: number): Promise<boolean> => {
      if (!contestPermissionMap.has(contestId))
        contestPermissionMap.set(
          contestId,
          getContest(contestId).then(
            async contest =>
              !!contest &&
              this.contestService.isUnveiled(contest, user) &&
              (await this.contestService.userHasPermission(user, contest, ContestPermissionType.View))
          )
        );
      return contestPermissionMap.get(contestId);
    };

    const visibleRows = (
      await Promise.all(
        reviews.map(async (review, index) => {
          const problem = problems[index];
          if (!problem) return null;

          const firstAcceptedSubmission = legacySubmissionMap.get(review.firstAcceptedSubmissionId);
          const hasStoredContestContext = !!review.sourceContestId && !!review.sourceContestProblemIndex;
          const contestId = hasStoredContestContext ? review.sourceContestId : firstAcceptedSubmission?.contestId;
          const contestProblemIndex = hasStoredContestContext
            ? review.sourceContestProblemIndex
            : firstAcceptedSubmission?.contestProblemIndex;

          if (contestId && contestProblemIndex) {
            const contest = await getContest(contestId);
            if (contest?.problemIds[contestProblemIndex - 1] === problem.id && (await canViewContest(contestId)))
              return { review, problem, contestId, contestProblemIndex };
          }

          if (!(await this.problemService.userHasPermission(user, problem, ProblemPermissionType.View))) return null;
          return { review, problem, contestId: null, contestProblemIndex: null };
        })
      )
    ).filter(row => row);

    const overdueCount = visibleRows.filter(({ review }) => review.dueAt.getTime() < now.getTime()).length;
    const selectedRows = visibleRows.slice(skipCount, skipCount + takeCount);
    const result = await Promise.all(
      selectedRows.map(async ({ review, problem, contestId, contestProblemIndex }): Promise<ProblemReviewMetaDto> => {
        const titleLocale = problem.locales.includes(locale) ? locale : problem.locales[0];
        return {
          problem: await this.problemService.getProblemMeta(problem),
          title: await this.problemService.getProblemLocalizedTitle(problem, titleLocale),
          contestId: contestId || undefined,
          contestProblemIndex: contestProblemIndex || undefined,
          reviewNumber: review.completedReviewCount + 1,
          totalReviewCount: PROBLEM_REVIEW_COUNT,
          availableAt: review.availableAt,
          dueAt: review.dueAt,
          ...this.getReviewTiming(review, now)
        };
      })
    );

    return {
      count: visibleRows.length,
      overdueCount,
      result
    };
  }
}
