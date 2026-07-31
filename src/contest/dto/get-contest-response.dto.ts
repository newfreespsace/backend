import { ApiProperty } from "@nestjs/swagger";

import { ContestMetaDto } from "./contest-meta.dto";

import { ContestProblemDto } from "./contest-problem.dto";

import { GroupMetaDto } from "@/group/dto";
import { UserMetaDto } from "@/user/dto";

import { ContestSubmissionState } from "../contest-submission-state.enum";

export enum GetContestResponseError {
  NO_SUCH_CONTEST = "NO_SUCH_CONTEST",
  PERMISSION_DENIED = "PERMISSION_DENIED"
}

export class GetContestResponseDto {
  @ApiProperty({ enum: GetContestResponseError })
  error?: GetContestResponseError;

  @ApiProperty({ type: ContestMetaDto })
  meta?: ContestMetaDto;

  @ApiProperty({ type: UserMetaDto })
  holder?: UserMetaDto;

  @ApiProperty({ type: GroupMetaDto })
  group?: GroupMetaDto;

  @ApiProperty({ type: [UserMetaDto] })
  admins?: UserMetaDto[];

  @ApiProperty({ type: [ContestProblemDto] })
  problems?: ContestProblemDto[];

  @ApiProperty()
  permissions?: {
    manage: boolean;
    viewRanklist: boolean;
    viewStatistics: boolean;
    unveiled: boolean;
    canSubmit: boolean;
    submissionState: ContestSubmissionState;
    postContestOpensAt: Date;
  };
}
