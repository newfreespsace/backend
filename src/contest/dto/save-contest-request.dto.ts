import { ApiProperty } from "@nestjs/swagger";
import { IsArray, IsBoolean, IsDateString, IsEnum, IsInt, IsOptional, IsString, MaxLength } from "class-validator";
import { IsObject } from "class-validator";

import { ContestType } from "../contest.entity";

export class SaveContestRequestDto {
  @ApiProperty()
  @IsOptional()
  @IsInt()
  contestId?: number;

  @ApiProperty()
  @IsString()
  @MaxLength(80)
  title: string;

  @ApiProperty()
  @IsString()
  subtitle: string;

  @ApiProperty()
  @IsString()
  information: string;

  @ApiProperty()
  @IsDateString()
  startTime: string;

  @ApiProperty()
  @IsDateString()
  endTime: string;

  @ApiProperty({ enum: ContestType })
  @IsEnum(ContestType)
  type: ContestType;

  @ApiProperty()
  @IsBoolean()
  isPublic: boolean;

  @ApiProperty()
  @IsBoolean()
  hideStatistics: boolean;

  @ApiProperty()
  @IsOptional()
  @IsInt()
  groupId?: number;

  @ApiProperty({ type: [Number] })
  @IsArray()
  problemIds: number[];

  @ApiProperty({ type: [Number] })
  @IsArray()
  adminIds: number[];

  @ApiProperty()
  @IsObject()
  rankingParams: Record<string, number>;
}
