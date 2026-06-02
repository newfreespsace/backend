import { ApiProperty } from "@nestjs/swagger";
import { IsIn, IsInt } from "class-validator";

import { Locale } from "@/common/locale.type";

export class GetContestRequestDto {
  @ApiProperty()
  @IsInt()
  contestId: number;

  @ApiProperty()
  @IsIn(["en_US", "zh_CN", "ja_JP"])
  locale: Locale;
}
