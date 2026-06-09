import { Type } from "class-transformer";
import { IsBoolean, IsEnum, IsNumber, IsOptional } from "class-validator";

import { Locale } from "@/common/locale.type";

export class GetSectionByIdDto {
  @Type(() => Number)
  @IsNumber()
  id: number;

  @IsEnum(Locale)
  locale: Locale;

  @IsBoolean()
  @IsOptional()
  titleOnly?: boolean;
}
