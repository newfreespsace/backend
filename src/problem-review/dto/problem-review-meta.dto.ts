import { ApiProperty } from "@nestjs/swagger";

import { ProblemMetaDto } from "@/problem/dto";

export class ProblemReviewMetaDto {
  @ApiProperty()
  problem: ProblemMetaDto;

  @ApiProperty()
  title: string;

  @ApiProperty()
  reviewNumber: number;

  @ApiProperty()
  totalReviewCount: number;

  @ApiProperty()
  availableAt: Date;

  @ApiProperty()
  dueAt: Date;

  @ApiProperty()
  overdue: boolean;

  @ApiProperty()
  overdueDays: number;
}
