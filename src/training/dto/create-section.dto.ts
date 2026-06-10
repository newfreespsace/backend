import { IsNumber, IsOptional, IsString } from "class-validator";

export class CreateSectionDto {
  @IsString()
  title: string;

  @IsString()
  @IsOptional()
  description?: string;

  @Type(() => Number)
  @IsNumber()
  chapterId: number;

  @Type(() => Number)
  @IsNumber()
  sortOrder: number;
}
