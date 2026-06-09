import { IsNumber, IsOptional, IsString } from "class-validator";

export class UpdateChapterDto {
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
  trainingId?: number;
}
