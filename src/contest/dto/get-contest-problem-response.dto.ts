import { ApiProperty } from "@nestjs/swagger";

import { ContestMetaDto } from "./contest-meta.dto";
import { ContestProblemDto } from "./contest-problem.dto";

import { GetProblemResponseDto } from "@/problem/dto";

import { ContestSubmissionState } from "../contest-submission-state.enum";

export enum GetContestProblemResponseError {
  NO_SUCH_CONTEST = "NO_SUCH_CONTEST",
  NO_SUCH_PROBLEM = "NO_SUCH_PROBLEM",
  PERMISSION_DENIED = "PERMISSION_DENIED",
  CONTEST_NOT_STARTED = "CONTEST_NOT_STARTED"
}

export class GetContestProblemResponseDto {
  @ApiProperty({ enum: GetContestProblemResponseError })
  error?: GetContestProblemResponseError;

  @ApiProperty({ type: ContestMetaDto })
  contest?: ContestMetaDto;

  @ApiProperty()
  pid?: number;

  @ApiProperty({ type: GetProblemResponseDto })
  problem?: GetProblemResponseDto;

  @ApiProperty({ type: [ContestProblemDto] })
  problems?: ContestProblemDto[];

  @ApiProperty()
  permissions?: {
    manageContest: boolean;
    running: boolean;
    ended: boolean;
    canSubmit: boolean;
    submissionState: ContestSubmissionState;
    postContestOpensAt: Date;
  };
}
