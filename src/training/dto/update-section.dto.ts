import { IsNumber, IsOptional, IsString } from "class-validator";

export class UpdateSectionDto {
  @IsNumber()
  id: number;

  @IsString()
  @IsOptional()
  title?: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsNumber()
  @IsOptional()
  sortOrder?: number;

  @IsNumber()
  @IsOptional()
  chapterId?: number;
}
