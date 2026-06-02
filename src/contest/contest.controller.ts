import { Body, Controller, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "@/common/user.decorator";
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
  SaveContestResponseError
} from "./dto";

@ApiTags("Contest")
@Controller("contest")
export class ContestController {
  constructor(private readonly contestService: ContestService, private readonly userService: UserService) {}

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
}
