import { IsNumber, IsOptional, IsString } from "class-validator";

export class CreateSectionDto {
  @IsString()
  title: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsNumber()
  chapterId: number;

  @IsNumber()
  sortOrder: number;
}
