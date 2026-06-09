import { IsNumber, IsOptional, IsString } from "class-validator";

export class CreateChapterDto {
  @IsString()
  title: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsNumber()
  trainingId: number;

  @IsNumber()
  sortOrder: number;
}
