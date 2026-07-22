import { ApiProperty } from "@nestjs/swagger";

import { Type } from "class-transformer";
import { IsArray, IsEnum, IsInt, ValidateNested } from "class-validator";

import { SectionProblemCategory } from "../entities/section_problem.entity";

class SetSectionProblemItemDto {
  @Type(() => Number)
  @IsInt()
  problemId: number;

  @ApiProperty({ enum: SectionProblemCategory })
  @IsEnum(SectionProblemCategory)
  category: SectionProblemCategory;

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
