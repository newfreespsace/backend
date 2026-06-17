import { ApiProperty } from "@nestjs/swagger";

export enum SaveContestResponseError {
  PERMISSION_DENIED = "PERMISSION_DENIED",
  NO_SUCH_CONTEST = "NO_SUCH_CONTEST",
  EMPTY_TITLE = "EMPTY_TITLE",
  INVALID_TIME_RANGE = "INVALID_TIME_RANGE",
  NO_SUCH_PROBLEM = "NO_SUCH_PROBLEM",
  GROUP_REQUIRED = "GROUP_REQUIRED",
  NO_SUCH_GROUP = "NO_SUCH_GROUP",
  NO_SUCH_USER = "NO_SUCH_USER"
}

export class SaveContestResponseDto {
  @ApiProperty({ enum: SaveContestResponseError })
  error?: SaveContestResponseError;

  @ApiProperty()
  contestId?: number;
}
