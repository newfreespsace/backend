import { ApiProperty } from "@nestjs/swagger";

import { IsBoolean, IsOptional, IsString, MaxLength } from "class-validator";

export class RemoteJudgeSettingsDto {
  @ApiProperty()
  atcoderSessionConfigured: boolean;

  @ApiProperty({ enum: ["site", "environment", "none"] })
  atcoderSessionSource: "site" | "environment" | "none";

  @ApiProperty({ enum: ["missing", "unchecked", "valid", "expired", "unavailable"] })
  atcoderSessionStatus: "missing" | "unchecked" | "valid" | "expired" | "unavailable";

  @ApiProperty()
  atcoderSessionLastCheckedAt?: Date;

  @ApiProperty()
  atcoderSessionError?: string;

  @ApiProperty()
  updatedAt?: Date;
}

export class GetRemoteJudgeSettingsResponseDto {
  @ApiProperty({ enum: ["PERMISSION_DENIED"] })
  error?: "PERMISSION_DENIED";

  @ApiProperty()
  settings?: RemoteJudgeSettingsDto;
}

export class UpdateRemoteJudgeSettingsRequestDto {
  @ApiProperty({ writeOnly: true, maxLength: 8192 })
  @IsOptional()
  @IsString()
  @MaxLength(8192)
  readonly atcoderSession?: string;

  @ApiProperty()
  @IsOptional()
  @IsBoolean()
  readonly clearAtcoderSession?: boolean;
}
