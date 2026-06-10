import { Type } from "class-transformer";
import { IsArray, IsInt, ValidateNested } from "class-validator";

class SetSectionProblemItemDto {
  @Type(() => Number)
  @IsInt()
  problemId: number;

  @Type(() => Number)
  @IsInt()
  sortOrder: number;
}

export class SetSectionProblemsDto {
  @Type(() => Number)
  @IsInt()
  sectionId: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SetSectionProblemItemDto)
  problems: SetSectionProblemItemDto[];
}
