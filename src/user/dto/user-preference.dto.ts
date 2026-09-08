import {
  IsEnum,
  IsOptional,
  IsBoolean,
  IsString,
  MaxLength,
  IsObject,
  Length,
  Min,
  Max,
  IsNumber,
  ValidateNested,
  IsIn,
  IsInt,
  IsArray,
  ArrayMinSize,
  ArrayMaxSize,
  ValidateBy
} from "class-validator";
import { Type } from "class-transformer";

import { Locale } from "@/common/locale.type";

import { UserPreference } from "../user-preference.interface";

class UserPreferenceProblemReviewScheduleItemDto {
  @IsInt()
  @Min(1)
  @Max(365)
  availableAfterDays: number;

  @IsInt()
  @Min(2)
  @Max(365)
  @ValidateBy({
    name: "reviewDeadlineAfterStart",
    validator: {
      validate: (value, args) => value > (args.object as UserPreferenceProblemReviewScheduleItemDto).availableAfterDays,
      defaultMessage: () => "overdueAfterDays must be greater than availableAfterDays"
    }
  })
  overdueAfterDays: number;
}

class UserPreferenceProblemReviewDto {
  @IsBoolean()
  enabled: boolean;

  @IsArray()
  @IsObject({ each: true })
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => UserPreferenceProblemReviewScheduleItemDto)
  schedule: UserPreferenceProblemReviewScheduleItemDto[];
}

class UserPreferenceLocaleDto {
  @IsEnum(Locale)
  @IsOptional()
  system?: Locale;

  @IsEnum(Locale)
  @IsOptional()
  content?: Locale;

  @IsBoolean()
  @IsOptional()
  hideUnavailableMessage?: boolean;
}

class UserPreferenceFontDto {
  @IsString()
  @Length(0, 36)
  @IsOptional()
  contentFontFace?: string;

  @IsString()
  @Length(0, 36)
  @IsOptional()
  codeFontFace?: string;

  @IsNumber()
  @Min(5)
  @Max(20)
  @IsOptional()
  codeFontSize?: number;

  @IsNumber()
  @Min(1)
  @Max(2)
  @IsOptional()
  codeLineHeight?: number;

  @IsBoolean()
  @IsOptional()
  codeFontLigatures?: boolean;

  @IsIn(["content", "code"])
  @IsOptional()
  markdownEditorFont?: string;
}

class UserPreferenceCodeFormatterDto {
  @IsBoolean()
  @IsOptional()
  disableByDefault?: boolean;

  @IsString()
  @MaxLength(1024)
  @IsOptional()
  options?: string;
}

class UserPreferenceCodeDto {
  @IsString()
  @MaxLength(20)
  defaultLanguage?: string;

  @IsObject()
  @IsOptional()
  defaultCompileAndRunOptions?: Record<string, string>;
}

export class UserPreferenceDto implements UserPreference {
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => UserPreferenceProblemReviewDto)
  problemReview?: UserPreferenceProblemReviewDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => UserPreferenceLocaleDto)
  locale?: UserPreferenceLocaleDto;

  @IsString()
  @MaxLength(20)
  theme?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => UserPreferenceFontDto)
  font?: UserPreferenceFontDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => UserPreferenceCodeFormatterDto)
  codeFormatter?: UserPreferenceCodeFormatterDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => UserPreferenceCodeDto)
  code?: UserPreferenceCodeDto;
}
