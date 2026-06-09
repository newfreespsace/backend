import { IsNumber, IsOptional, IsString } from "class-validator";

export class CreateTrainingDto {
  @IsString()
  title: string;

  @IsString()
  @IsOptional()
  description?: string;

  @IsNumber()
  sortOrder: number;
}
