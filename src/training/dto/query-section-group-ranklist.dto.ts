import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsOptional } from "class-validator";

import { GroupMetaDto } from "@/group/dto";
import { UserMetaDto } from "@/user/dto";

export class QuerySectionGroupRanklistDto {
  @Type(() => Number)
  @IsInt()
  sectionId: number;

  @Type(() => Number)
  @IsOptional()
  @IsInt()
  groupId?: number;
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
  groupId?: number;

  @ApiProperty({ type: [GroupMetaDto] })
  groups: GroupMetaDto[];

  @ApiProperty()
  memberCount: number;

  @ApiProperty()
  problemCount: number;

  @ApiProperty({ type: [SectionGroupRanklistItemDto] })
  result: SectionGroupRanklistItemDto[];
}
