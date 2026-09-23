import { ApiProperty } from "@nestjs/swagger";

export class ProblemDifficultyRatingDto {
  @ApiProperty({ required: false })
  score?: number;

  @ApiProperty()
  canRate: boolean;

  @ApiProperty({ required: false })
  average?: number;

  @ApiProperty({ required: false, minimum: 1, maximum: 5 })
  difficulty?: number;
}

export enum ProblemDifficultyRatingError {
  NO_SUCH_PROBLEM = "NO_SUCH_PROBLEM",
  PERMISSION_DENIED = "PERMISSION_DENIED"
}

export class ProblemDifficultyRatingResponseDto {
  @ApiProperty({ enum: ProblemDifficultyRatingError, required: false })
  error?: ProblemDifficultyRatingError;

  @ApiProperty({ type: ProblemDifficultyRatingDto, required: false })
  rating?: ProblemDifficultyRatingDto;
}
