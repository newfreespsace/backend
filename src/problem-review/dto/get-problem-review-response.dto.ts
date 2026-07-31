import { ApiProperty } from "@nestjs/swagger";

export class CurrentProblemReviewDto {
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

export class GetProblemReviewResponseDto {
  @ApiProperty()
  review?: CurrentProblemReviewDto;
}
