import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt } from "class-validator";

import { UserMetaDto } from "@/user/dto";

export class QuerySectionGroupRanklistDto {
  @Type(() => Number)
  @IsInt()
  sectionId: number;

  @Type(() => Number)
  @IsInt()
  groupId: number;
}

export class SectionGroupRanklistItemDto {
  @ApiProperty()
  rank: number;

  @ApiProperty()
  user: UserMetaDto;

  @ApiProperty()
  acceptedProblemCount: number;

  @ApiProperty({ type: [Number] })
  acceptedProblemIds: number[];
}

export class QuerySectionGroupRanklistResponseDto {
  @ApiProperty()
  sectionId: number;

  @ApiProperty()
  groupId: number;

  @ApiProperty()
  problemCount: number;

  @ApiProperty({ type: [SectionGroupRanklistItemDto] })
  result: SectionGroupRanklistItemDto[];
}
