import { ApiProperty } from "@nestjs/swagger";

import { IsEnum, IsInt, Max, Min } from "class-validator";

import { Locale } from "@/common/locale.type";

export class QueryProblemReviewsRequestDto {
  @ApiProperty({ enum: Locale })
  @IsEnum(Locale)
  locale: Locale;

  @ApiProperty()
  @IsInt()
  @Min(0)
  skipCount: number;

  @ApiProperty()
  @IsInt()
  @Min(1)
  @Max(100)
  takeCount: number;
}
