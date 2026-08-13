import { Type } from "class-transformer";
import { IsInt, IsNumber, IsOptional, IsString, Min } from "class-validator";

export class CreateTrainingDto {
  @IsString()
  title: string;

  @IsString()
  @IsOptional()
  description?: string;

  @Type(() => Number)
  @IsNumber()
  sortOrder: number;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  pointsPerProblem: number;
}
