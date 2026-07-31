import { ApiProperty } from "@nestjs/swagger";

import { IsEnum, IsIn, IsInt, IsOptional } from "class-validator";

import { Locale } from "@/common/locale.type";

import { ContestRanklistScope } from "../contest-player.entity";

export class GetContestRanklistRequestDto {
  @ApiProperty()
  @IsInt()
  contestId: number;

  @ApiProperty()
  @IsIn(["en_US", "zh_CN", "ja_JP"])
  locale: Locale;

  @ApiProperty({ enum: ContestRanklistScope, required: false })
  @IsOptional()
  @IsEnum(ContestRanklistScope)
  ranklistScope?: ContestRanklistScope;
}
