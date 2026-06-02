import { ApiProperty } from "@nestjs/swagger";

import { ContestMetaDto } from "./contest-meta.dto";
import { ContestProblemDto } from "./contest-problem.dto";
import { ContestRanklistRowDto } from "./contest-ranklist-row.dto";

export enum GetContestRanklistResponseError {
  NO_SUCH_CONTEST = "NO_SUCH_CONTEST",
  PERMISSION_DENIED = "PERMISSION_DENIED"
}

export class GetContestRanklistResponseDto {
  @ApiProperty({ enum: GetContestRanklistResponseError })
  error?: GetContestRanklistResponseError;

  @ApiProperty({ type: ContestMetaDto })
  meta?: ContestMetaDto;

  @ApiProperty({ type: [ContestProblemDto] })
  problems?: ContestProblemDto[];

  @ApiProperty({ type: [ContestRanklistRowDto] })
  rows?: ContestRanklistRowDto[];
}
