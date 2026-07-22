import { ApiProperty } from "@nestjs/swagger";

import { QueryProblemSetResponseItemDto } from "@/problem/dto/query-problem-set-response.dto";

import { SectionMetaDto } from "./training-meta.dto";

import { SectionProblemCategory } from "../entities/section_problem.entity";

export class SectionProblemDto extends QueryProblemSetResponseItemDto {
  @ApiProperty({ enum: SectionProblemCategory })
  category: SectionProblemCategory;

  @ApiProperty()
  sortOrder: number;
}

export class GetSectionByIdResponseDto extends SectionMetaDto {
  @ApiProperty({ type: [SectionProblemDto] })
  problems: SectionProblemDto[];
}
