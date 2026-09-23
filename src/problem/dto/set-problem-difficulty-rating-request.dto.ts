import { ApiProperty } from "@nestjs/swagger";

import { IsInt, Max, Min } from "class-validator";

export class SetProblemDifficultyRatingRequestDto {
  @ApiProperty()
  @IsInt()
  readonly problemId: number;

  @ApiProperty({ minimum: 1, maximum: 5 })
  @IsInt()
  @Min(1)
  @Max(5)
  readonly score: number;
}
