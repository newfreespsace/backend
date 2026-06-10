import { ApiProperty } from "@nestjs/swagger";

import { QueryProblemSetResponseItemDto } from "@/problem/dto/query-problem-set-response.dto";

import { SectionMetaDto } from "./training-meta.dto";

export class GetSectionByIdResponseDto extends SectionMetaDto {
  @ApiProperty({ type: [QueryProblemSetResponseItemDto] })
  problems: QueryProblemSetResponseItemDto[];
}
