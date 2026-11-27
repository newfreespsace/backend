import { Body, Controller, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { Type } from "class-transformer";
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested
} from "class-validator";

import { CodeLanguage } from "@/code-language/code-language.type";
import { CurrentUser } from "@/common/user.decorator";
import { UserEntity } from "@/user/user.entity";

import { HackService } from "./hack.service";
import { HACK_INPUT_MAX } from "./hack.types";

class IdDto {
  @IsInt()
  @Min(1)
  id: number;
}

class HistoryDto extends IdDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  before?: number;
}

class TargetsDto {
  @IsInt()
  @Min(1)
  problemId: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  contestId?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  before?: number;
}

class CreateDto extends IdDto {
  @IsString()
  @MaxLength(HACK_INPUT_MAX)
  input: string;
}

class MineDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  id?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  before?: number;
}

class DownloadDto extends IdDto {
  @IsBoolean()
  input: boolean;

  @IsBoolean()
  output: boolean;
}

class RevokeDto extends IdDto {
  @IsString()
  @Length(1, 500)
  reason: string;
}

class ProgramDto {
  @IsEnum(CodeLanguage)
  language: CodeLanguage;

  @IsString()
  @Length(1, 128 * 1024)
  code: string;

  @IsObject()
  compileAndRunOptions: unknown;
}

class ProfileDto {
  @IsInt()
  @Min(1)
  problemId: number;

  @IsBoolean()
  enabled: boolean;

  @IsInt()
  @Min(1)
  @Max(HACK_INPUT_MAX)
  inputLimit: number;

  @IsOptional()
  @ValidateNested()
  @Type(() => ProgramDto)
  validator: ProgramDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => ProgramDto)
  reference: ProgramDto;
}

@ApiTags("Hack")
@ApiBearerAuth()
@Controller("hack")
export class HackController {
  constructor(private readonly hack: HackService) {}

  @Post("targets")
  async targets(@CurrentUser() user: UserEntity, @Body() request: TargetsDto) {
    return await this.hack.targets(user, request.problemId, request.contestId, request.before);
  }

  @Post("create")
  async create(@CurrentUser() user: UserEntity, @Body() request: CreateDto) {
    return await this.hack.create(user, request.id, request.input);
  }

  @Post("history")
  async history(@CurrentUser() user: UserEntity, @Body() request: HistoryDto) {
    return await this.hack.targetHistory(user, request.id, request.before);
  }

  @Post("mine")
  async mine(@CurrentUser() user: UserEntity, @Body() request: MineDto) {
    return await this.hack.mine(user, request.before, request.id);
  }

  @Post("download")
  async download(@CurrentUser() user: UserEntity, @Body() request: DownloadDto) {
    return await this.hack.download(user, request.id, request.input, request.output);
  }

  @Post("cancel")
  async cancel(@CurrentUser() user: UserEntity, @Body() request: IdDto) {
    return await this.hack.cancel(user, request.id);
  }

  @Post("revoke")
  async revoke(@CurrentUser() user: UserEntity, @Body() request: RevokeDto) {
    return await this.hack.revoke(user, request.id, request.reason);
  }

  @Post("profile")
  async profile(@CurrentUser() user: UserEntity, @Body() request: IdDto) {
    return await this.hack.getProfile(user, request.id);
  }

  @Post("saveProfile")
  async saveProfile(@CurrentUser() user: UserEntity, @Body() request: ProfileDto) {
    return await this.hack.saveProfile(user, request);
  }
}
