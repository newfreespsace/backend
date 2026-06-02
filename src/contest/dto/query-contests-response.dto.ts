import { ApiProperty } from "@nestjs/swagger";

import { ContestMetaDto } from "./contest-meta.dto";

export enum QueryContestsResponseError {
  PERMISSION_DENIED = "PERMISSION_DENIED"
}

export class QueryContestsResponseDto {
  @ApiProperty({ enum: QueryContestsResponseError })
  error?: QueryContestsResponseError;

  @ApiProperty()
  count?: number;

  @ApiProperty({ type: [ContestMetaDto] })
  result?: ContestMetaDto[];

  @ApiProperty()
  permissions?: {
    createContest: boolean;
    filterNonpublic: boolean;
  };
}
