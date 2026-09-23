import { ApiProperty } from "@nestjs/swagger";
import { IsInt } from "class-validator";

export class GetProblemDifficultyRatingRequestDto {
  @ApiProperty()
  @IsInt()
  readonly problemId: number;
}
