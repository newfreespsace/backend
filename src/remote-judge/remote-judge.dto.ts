import { IsBoolean, IsEnum, IsIn, IsInt, IsNumber, IsOptional, IsString, MaxLength, Min } from "class-validator";

import { SubmissionMethod } from "./remote-judge.types";

export class RemotePlatformDto {
  @IsIn([SubmissionMethod.Codeforces, SubmissionMethod.AtCoder])
  platform: SubmissionMethod;
}

export class BindRemoteAccountDto extends RemotePlatformDto {
  @IsString()
  @MaxLength(64)
  handle: string;
}

export class RemoteContextDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  problemId?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  contestId?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  contestProblemIndex?: number;
}

export class RemoteActivateDto extends RemoteContextDto {
  @IsOptional()
  @IsBoolean()
  submissionIntent?: boolean;
}

export class SetCodeforcesCredentialsDto {
  @IsOptional()
  @IsString()
  @MaxLength(256)
  apiKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  apiSecret?: string;

  @IsOptional()
  @IsBoolean()
  clear?: boolean;
}

export class SetAtcoderSessionDto {
  @IsOptional()
  @IsString()
  @MaxLength(8206)
  atcoderSession?: string;

  @IsOptional()
  @IsBoolean()
  clear?: boolean;
}

export class SetSubmissionMethodDto {
  @IsOptional()
  @IsBoolean()
  submittable?: boolean;

  @IsInt()
  @Min(1)
  problemId: number;

  @IsEnum(SubmissionMethod)
  submissionMethod: SubmissionMethod;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  remoteUrl?: string;

  @IsOptional()
  @IsNumber()
  @Min(0.001)
  remoteFullScore?: number;
}
