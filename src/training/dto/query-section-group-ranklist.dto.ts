import { ApiProperty } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsInt, IsOptional } from "class-validator";

import { GroupMetaDto } from "@/group/dto";
import { SubmissionStatus } from "@/submission/submission-status.enum";
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

export class SectionGroupRanklistProblemSubmissionDto {
  @ApiProperty()
  problemId: number;

  @ApiProperty()
  submissionId: number;

  @ApiProperty({ enum: SubmissionStatus })
  status: SubmissionStatus;

  @ApiProperty()
  canView: boolean;
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

  @ApiProperty({ type: [SectionGroupRanklistProblemSubmissionDto] })
  submissions: SectionGroupRanklistProblemSubmissionDto[];
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
