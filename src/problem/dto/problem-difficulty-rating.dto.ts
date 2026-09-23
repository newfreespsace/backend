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

export class ProblemDifficultyRatingEntryDto {
  @ApiProperty()
  userId: number;

  @ApiProperty()
  username: string;

  @ApiProperty()
  nickname: string;

  @ApiProperty()
  isAdmin: boolean;

  @ApiProperty({ minimum: 1, maximum: 5 })
  score: number;

  @ApiProperty()
  updatedAt: Date;

  @ApiProperty()
  counted: boolean;
}

export class ProblemDifficultyRatingsResponseDto {
  @ApiProperty({ enum: ProblemDifficultyRatingError, required: false })
  error?: ProblemDifficultyRatingError;

  @ApiProperty({ type: [ProblemDifficultyRatingEntryDto], required: false })
  ratings?: ProblemDifficultyRatingEntryDto[];
}
