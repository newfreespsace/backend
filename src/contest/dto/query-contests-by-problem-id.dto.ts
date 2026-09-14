import { ApiProperty } from "@nestjs/swagger";

import { Type } from "class-transformer";
import { IsInt } from "class-validator";

export class QueryContestsByProblemIdDto {
  @Type(() => Number)
  @IsInt()
  problemId: number;
}

export class ProblemReferencedContestDto {
  @ApiProperty()
  contestId: number;

  @ApiProperty()
  contestTitle: string;
}

export class QueryContestsByProblemIdResponseDto {
  @ApiProperty({ type: [ProblemReferencedContestDto] })
  references: ProblemReferencedContestDto[];
}
