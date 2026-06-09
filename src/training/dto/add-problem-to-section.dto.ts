import { IsNumber } from "class-validator";

export class AddProblemToSectionDto {
  @IsNumber()
  sectionId: number;

  @IsNumber()
  problemId: number;

  @IsNumber()
  sortOrder: number;
}
