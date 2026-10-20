import { ApiProperty } from "@nestjs/swagger";

import { ValidateNested, IsEnum, IsOptional, IsString, MaxLength, IsNumber, Min } from "class-validator";
import { Type } from "class-transformer";

import { SubmissionMethod } from "@/remote-judge/remote-judge.types";

import { ProblemStatementDto } from "./problem-statement.dto";

import { ProblemType } from "../problem.entity";

export class CreateProblemRequestDto {
  @ApiProperty()
  @IsEnum(ProblemType)
  readonly type: ProblemType;

  @ApiProperty({ enum: SubmissionMethod, required: false })
  @IsOptional()
  @IsEnum(SubmissionMethod)
  readonly submissionMethod?: SubmissionMethod;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  readonly remoteUrl?: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Min(0.001)
  readonly remoteFullScore?: number;

  @ApiProperty()
  @ValidateNested()
  @Type(() => ProblemStatementDto)
  readonly statement: ProblemStatementDto;
}
