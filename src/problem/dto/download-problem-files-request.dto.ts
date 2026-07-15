import { ApiProperty } from "@nestjs/swagger";

import { IsInt, IsEnum, Length, IsString, IsArray, IsOptional, Min } from "class-validator";

import { ProblemFileType } from "../problem-file.entity";

export class DownloadProblemFilesRequestDto {
  @ApiProperty()
  @IsInt()
  readonly problemId: number;

  @ApiProperty({ required: false, description: "Contest context used to authorize access to a private problem." })
  @IsInt()
  @Min(1)
  @IsOptional()
  readonly contestId?: number;

  @ApiProperty({ required: false })
  @IsInt()
  @Min(1)
  @IsOptional()
  readonly contestProblemIndex?: number;

  @ApiProperty()
  @IsEnum(ProblemFileType)
  readonly type: ProblemFileType;

  @ApiProperty({ type: String, isArray: true })
  @IsString({ each: true })
  @Length(1, 256, { each: true })
  @IsArray()
  readonly filenameList: string[];
}
