import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

import { Type } from "class-transformer";
import { IsInt, Min } from "class-validator";

import { UserMetaDto } from "@/user/dto";

export enum QueryTrainingRanklistResponseError {
  TAKE_TOO_MANY = "TAKE_TOO_MANY"
}

export class QueryTrainingRanklistDto {
  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  trainingId: number;

  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  skipCount: number;

  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  takeCount: number;
}

export class TrainingRanklistItemDto {
  @ApiProperty()
  rank: number;

  @ApiProperty()
  user: UserMetaDto;

  @ApiProperty()
  acceptedProblemCount: number;

  @ApiProperty()
  lastSubmissionTime: Date;
}

export class QueryTrainingRanklistResponseDto {
  @ApiPropertyOptional({ enum: QueryTrainingRanklistResponseError })
  error?: QueryTrainingRanklistResponseError;

  @ApiPropertyOptional()
  trainingId?: number;

  @ApiPropertyOptional()
  problemCount?: number;

  @ApiPropertyOptional()
  count?: number;

  @ApiPropertyOptional({ type: [TrainingRanklistItemDto] })
  result?: TrainingRanklistItemDto[];
}
