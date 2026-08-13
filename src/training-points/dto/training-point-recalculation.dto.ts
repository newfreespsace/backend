import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

import { Type } from "class-transformer";
import { IsBoolean, IsInt, IsOptional, Min } from "class-validator";

import { TrainingPointRecalculationStatus } from "../entities/training-point-recalculation-task.entity";

export enum StartTrainingPointRecalculationResponseError {
  PermissionDenied = "PERMISSION_DENIED",
  AlreadyRunning = "ALREADY_RUNNING"
}

export enum GetTrainingPointRecalculationResponseError {
  PermissionDenied = "PERMISSION_DENIED",
  NotFound = "NOT_FOUND"
}

export class StartTrainingPointRecalculationRequestDto {
  @ApiProperty()
  @IsBoolean()
  dryRun: boolean;
}

export class GetTrainingPointRecalculationRequestDto {
  @ApiPropertyOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  taskId?: number;
}

export class TrainingPointRecalculationSummaryDto {
  @ApiProperty()
  affectedUserCount: number;

  @ApiProperty()
  currentRecordCount: number;

  @ApiProperty()
  expectedRecordCount: number;

  @ApiProperty()
  addedRecordCount: number;

  @ApiProperty()
  updatedRecordCount: number;

  @ApiProperty()
  deletedRecordCount: number;

  @ApiProperty()
  beforeTotalPoints: number;

  @ApiProperty()
  afterTotalPoints: number;

  @ApiProperty()
  validationPassed: boolean;
}

export class TrainingPointRecalculationTaskDto {
  @ApiProperty()
  id: number;

  @ApiProperty()
  dryRun: boolean;

  @ApiProperty({ enum: TrainingPointRecalculationStatus })
  status: TrainingPointRecalculationStatus;

  @ApiPropertyOptional({ type: TrainingPointRecalculationSummaryDto })
  summary?: TrainingPointRecalculationSummaryDto;

  @ApiPropertyOptional()
  error?: string;

  @ApiProperty()
  createdAt: Date;

  @ApiPropertyOptional()
  startedAt?: Date;

  @ApiPropertyOptional()
  finishedAt?: Date;
}

export class StartTrainingPointRecalculationResponseDto {
  @ApiPropertyOptional({ enum: StartTrainingPointRecalculationResponseError })
  error?: StartTrainingPointRecalculationResponseError;

  @ApiPropertyOptional({ type: TrainingPointRecalculationTaskDto })
  task?: TrainingPointRecalculationTaskDto;
}

export class GetTrainingPointRecalculationResponseDto {
  @ApiPropertyOptional({ enum: GetTrainingPointRecalculationResponseError })
  error?: GetTrainingPointRecalculationResponseError;

  @ApiPropertyOptional({ type: TrainingPointRecalculationTaskDto })
  task?: TrainingPointRecalculationTaskDto;
}
