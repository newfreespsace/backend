import { Body, Controller, Inject, Post, forwardRef } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "@/common/user.decorator";
import { Locale } from "@/common/locale.type";
import { DiscussionService } from "@/discussion/discussion.service";
import { ProblemService } from "@/problem/problem.service";
import { SubmissionStatus } from "@/submission/submission-status.enum";
import { SubmissionService } from "@/submission/submission.service";
import { UserEntity } from "@/user/user.entity";
import { UserService } from "@/user/user.service";

import { ContestPermissionType, ContestService } from "./contest.service";

import {
  GetContestRanklistRequestDto,
  GetContestRanklistResponseDto,
  GetContestRanklistResponseError,
  GetContestRequestDto,
  GetContestResponseDto,
  GetContestResponseError,
  QueryContestsRequestDto,
  QueryContestsResponseDto,
  QueryContestsResponseError,
  SaveContestRequestDto,
  SaveContestResponseDto,
  GetContestProblemRequestDto,
  GetContestProblemResponseDto,
  GetContestProblemResponseError,
  SaveContestResponseError
} from "./dto";

@ApiTags("Contest")
@Controller("contest")
export class ContestController {
  constructor(
    @Inject(forwardRef(() => ContestService))
    private readonly contestService: ContestService,
    @Inject(forwardRef(() => UserService))
    private readonly userService: UserService,
    @Inject(forwardRef(() => ProblemService))
    private readonly problemService: ProblemService,
    @Inject(forwardRef(() => SubmissionService))
    private readonly submissionService: SubmissionService,
    @Inject(forwardRef(() => DiscussionService))
    private readonly discussionService: DiscussionService
  ) {}

  @Post("queryContests")
  @ApiBearerAuth()
  @ApiOperation({ summary: "Query contests." })
  async queryContests(
    @CurrentUser() currentUser: UserEntity,
    @Body() request: QueryContestsRequestDto
  ): Promise<QueryContestsResponseDto> {
    const [contests, count] = await this.contestService.queryContests(
      currentUser,
      request.skipCount,
      request.takeCount,
      request.nonpublic
    );
    if (count === -1) return { error: QueryContestsResponseError.PERMISSION_DENIED };

    const canCreate = await this.contestService.userHasPermission(currentUser, null, ContestPermissionType.Create);
    return {
      count,
      result: contests.map(contest => this.contestService.getContestMeta(contest)),
      permissions: {
        createContest: canCreate,
        filterNonpublic: canCreate
      }
    };
  }

  @Post("getContest")
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get contest detail." })
  async getContest(
    @CurrentUser() currentUser: UserEntity,
    @Body() request: GetContestRequestDto
  ): Promise<GetContestResponseDto> {
    const contest = await this.contestService.findContestById(request.contestId);
    if (!contest) return { error: GetContestResponseError.NO_SUCH_CONTEST };
    if (!(await this.contestService.userHasPermission(currentUser, contest, ContestPermissionType.View)))
      return { error: GetContestResponseError.PERMISSION_DENIED };

    const manage = await this.contestService.userHasPermission(currentUser, contest, ContestPermissionType.Manage);
    const viewRanklist = await this.contestService.userHasPermission(
      currentUser,
      contest,
      ContestPermissionType.ViewRanklist
    );
    const viewStatistics = await this.contestService.userHasPermission(
      currentUser,
      contest,
      ContestPermissionType.ViewStatistics
    );
    const unveiled = this.contestService.isUnveiled(contest, currentUser);

    const [holder, admins, problems] = await Promise.all([
      this.userService.findUserById(contest.holderId),
      this.userService.findUsersByExistingIds(contest.adminIds),
      unveiled ? this.contestService.getContestProblems(contest, request.locale, currentUser, viewStatistics) : []
    ]);

    return {
      meta: this.contestService.getContestMeta(contest),
      holder: await this.userService.getUserMeta(holder, currentUser),
      admins: await Promise.all(admins.filter(Boolean).map(admin => this.userService.getUserMeta(admin, currentUser))),
      problems,
      permissions: {
        manage,
        viewRanklist,
        viewStatistics,
        unveiled
      }
    };
  }

  @Post("saveContest")
  @ApiBearerAuth()
  @ApiOperation({ summary: "Create or update a contest." })
  async saveContest(
    @CurrentUser() currentUser: UserEntity,
    @Body() request: SaveContestRequestDto
  ): Promise<SaveContestResponseDto> {
    const result = await this.contestService.saveContest(currentUser, request);
    if (typeof result === "string") return { error: SaveContestResponseError[result] };
    return { contestId: result.id };
  }

  @Post("getContestRanklist")
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get contest ranklist." })
  async getContestRanklist(
    @CurrentUser() currentUser: UserEntity,
    @Body() request: GetContestRanklistRequestDto
  ): Promise<GetContestRanklistResponseDto> {
    const contest = await this.contestService.findContestById(request.contestId);
    if (!contest) return { error: GetContestRanklistResponseError.NO_SUCH_CONTEST };
    if (!(await this.contestService.userHasPermission(currentUser, contest, ContestPermissionType.ViewRanklist)))
      return { error: GetContestRanklistResponseError.PERMISSION_DENIED };

    return {
      meta: this.contestService.getContestMeta(contest),
      problems: await this.contestService.getContestProblems(contest, request.locale, currentUser, false),
      rows: await this.contestService.getRanklistRows(contest, currentUser)
    };
  }

  @Post("getContestProblem")
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get problem in contest." })
  async getContestProblem(
    @CurrentUser() currentUser: UserEntity,
    @Body() request: GetContestProblemRequestDto
  ): Promise<GetContestProblemResponseDto> {
    const contestId = request.contestId;
    const pid = request.pid;

    const contest = await this.contestService.findContestById(contestId);
    if (!contest) return { error: GetContestProblemResponseError.NO_SUCH_CONTEST };

    if (!(await this.contestService.userHasPermission(currentUser, contest, ContestPermissionType.View))) {
      return { error: GetContestProblemResponseError.PERMISSION_DENIED };
    }

    const problemId = contest.problemIds[pid - 1];
    if (!problemId) return { error: GetContestProblemResponseError.NO_SUCH_PROBLEM };

    const isManager = await this.contestService.userHasPermission(currentUser, contest, ContestPermissionType.Manage);

    const unveiled = this.contestService.isUnveiled(contest, currentUser);

    if (!unveiled) {
      return { error: GetContestProblemResponseError.CONTEST_NOT_STARTED };
    }

    const problem = await this.problemService.findProblemById(problemId);
    if (!problem) return { error: GetContestProblemResponseError.NO_SUCH_PROBLEM };

    const locale: Locale = request.locale;
    const resultLocale = problem.locales.includes(locale) ? locale : problem.locales[0];
    const [judgeInfo, submittable] = await this.problemService.getProblemPreprocessedJudgeInfo(problem);
    const [lastSubmission, lastAcceptedSubmission] = currentUser
      ? await Promise.all([
          this.submissionService
            .getUserLatestSubmissionByProblems(currentUser, [problem], false)
            .then(map => map.get(problem.id)),
          this.submissionService
            .getUserLatestSubmissionByProblems(currentUser, [problem], true)
            .then(map => map.get(problem.id))
        ])
      : [null, null];
    const effectiveLastAcceptedSubmission =
      lastSubmission && lastSubmission.status === SubmissionStatus.Accepted ? lastSubmission : lastAcceptedSubmission;

    return {
      contest: this.contestService.getContestMeta(contest),
      pid,
      problem: {
        meta: await this.problemService.getProblemMeta(problem, true),
        tagsOfLocale: await this.problemService
          .getProblemTagsByProblem(problem)
          .then(problemTags =>
            Promise.all(problemTags.map(problemTag => this.problemService.getProblemTagLocalized(problemTag, locale)))
          ),
        localizedContentsOfLocale: {
          locale: resultLocale,
          title: await this.problemService.getProblemLocalizedTitle(problem, resultLocale),
          contentSections: await this.problemService.getProblemLocalizedContent(problem, resultLocale)
        },
        samples: await this.problemService.getProblemSamples(problem),
        judgeInfo,
        submittable,
        discussionCount: await this.discussionService.getDiscussionCountOfProblem(problem),
        permissionOfCurrentUser: await this.problemService.getUserPermissions(currentUser, problem),
        lastSubmission: currentUser
          ? {
              lastSubmission: lastSubmission && (await this.submissionService.getSubmissionBasicMeta(lastSubmission)),
              lastAcceptedSubmission:
                effectiveLastAcceptedSubmission &&
                (await this.submissionService.getSubmissionBasicMeta(effectiveLastAcceptedSubmission)),
              lastSubmissionContent:
                lastSubmission && (await this.submissionService.getSubmissionDetail(lastSubmission)).content
            }
          : {}
      },
      permissions: {
        manageContest: isManager,
        running: this.contestService.isRunning(contest),
        ended: this.contestService.isEnded(contest)
      }
    };
  }
}
