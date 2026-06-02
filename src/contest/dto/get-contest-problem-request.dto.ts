import { IsInt, IsEnum, Min } from "class-validator";

import { Locale } from "@/common/locale.type";

export class GetContestProblemRequestDto {
  @IsInt()
  contestId: number;

  @IsInt()
  @Min(1)
  pid: number;

  @IsEnum(Locale)
  locale: Locale;
}
