import { Body, Controller, ForbiddenException, Post } from "@nestjs/common";

import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "@/common/user.decorator";
import { UserEntity } from "@/user/user.entity";

import { ProblemReviewService } from "./problem-review.service";

import {
  GetProblemReviewRequestDto,
  GetProblemReviewResponseDto,
  QueryProblemReviewsRequestDto,
  QueryProblemReviewsResponseDto
} from "./dto";

@ApiTags("Problem Review")
@Controller("problemReview")
export class ProblemReviewController {
  constructor(private readonly problemReviewService: ProblemReviewService) {}

  @Post("queryDueReviews")
  @ApiBearerAuth()
  @ApiOperation({ summary: "Query the current user's due problem reviews." })
  async queryDueReviews(
    @CurrentUser() currentUser: UserEntity,
    @Body() request: QueryProblemReviewsRequestDto
  ): Promise<QueryProblemReviewsResponseDto> {
    if (!currentUser) throw new ForbiddenException("permission denied");
    return await this.problemReviewService.queryDueReviews(
      currentUser,
      request.locale,
      request.skipCount,
      request.takeCount
    );
  }

  @Post("getProblemReview")
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get a due review for one problem." })
  async getProblemReview(
    @CurrentUser() currentUser: UserEntity,
    @Body() request: GetProblemReviewRequestDto
  ): Promise<GetProblemReviewResponseDto> {
    if (!currentUser) throw new ForbiddenException("permission denied");
    return {
      review: await this.problemReviewService.getCurrentProblemReview(currentUser, request.problemId)
    };
  }
}
