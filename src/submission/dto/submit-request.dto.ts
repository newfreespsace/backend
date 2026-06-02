import { ApiProperty } from "@nestjs/swagger";

import { Type } from "class-transformer";
import { IsInt, IsObject, IsOptional, ValidateNested } from "class-validator";

import { FileUploadInfoDto } from "@/file/dto";

export class SubmitRequestDto {
  @ApiProperty()
  @IsInt()
  readonly problemId: number;

  @ApiProperty({ required: false })
  @IsInt()
  @IsOptional()
  readonly contestId?: number;

  @ApiProperty({ required: false })
  @IsInt()
  @IsOptional()
  readonly contestProblemIndex?: number;

  @ApiProperty()
  @IsObject()
  readonly content: unknown;

  @ApiProperty()
  @ValidateNested()
  @Type(() => FileUploadInfoDto)
  @IsOptional()
  readonly uploadInfo?: FileUploadInfoDto;
}
