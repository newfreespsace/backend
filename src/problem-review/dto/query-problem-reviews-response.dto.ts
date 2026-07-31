import { ApiProperty } from "@nestjs/swagger";

import { ProblemReviewMetaDto } from "./problem-review-meta.dto";

export class QueryProblemReviewsResponseDto {
  @ApiProperty()
  count: number;

  @ApiProperty()
  overdueCount: number;

  @ApiProperty({ type: [ProblemReviewMetaDto] })
  result: ProblemReviewMetaDto[];
}
