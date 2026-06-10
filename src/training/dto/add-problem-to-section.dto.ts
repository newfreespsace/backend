import { Type } from "class-transformer";
import { IsNumber } from "class-validator";

export class AddProblemToSectionDto {
  @Type(() => Number)
  @IsNumber()
  sectionId: number;

  @Type(() => Number)
  @IsNumber()
  problemId: number;

  @Type(() => Number)
  @IsNumber()
  sortOrder: number;
}
