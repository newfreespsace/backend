import { Type } from "class-transformer";
import { IsNumber, IsOptional, IsString } from "class-validator";

export class UpdateSectionDto {
  @Type(() => Number)
  @IsNumber()
  id: number;

  @IsString()
  @IsOptional()
  title?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @Type(() => Number)
  @IsNumber()
  @IsOptional()
  sortOrder?: number;

  @Type(() => Number)
  @IsNumber()
  @IsOptional()
  chapterId?: number;
}
