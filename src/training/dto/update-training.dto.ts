import { Type } from "class-transformer";
import { IsInt, IsNumber, IsOptional, IsString, Min } from "class-validator";

export class UpdateTrainingDto {
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
  @IsInt()
  @Min(0)
  @IsOptional()
  pointsPerProblem?: number;
}
