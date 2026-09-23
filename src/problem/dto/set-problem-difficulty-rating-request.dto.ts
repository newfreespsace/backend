import { ApiProperty } from "@nestjs/swagger";
import { IsInt, Max, Min } from "class-validator";

export class SetProblemDifficultyRatingRequestDto {
  @ApiProperty()
  @IsInt()
  readonly problemId: number;

  // Zero removes the user's rating.
  @ApiProperty({ minimum: 0, maximum: 5 })
  @IsInt()
  @Min(0)
  @Max(5)
  readonly score: number;
}
