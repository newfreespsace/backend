import { ApiProperty } from "@nestjs/swagger";

import { Type } from "class-transformer";
import { IsInt } from "class-validator";

export class QuerySectionsByProblemIdDto {
  @Type(() => Number)
  @IsInt()
  problemId: number;
}

export class ProblemReferencedSectionDto {
  @ApiProperty()
  trainingId: number;

  @ApiProperty()
  trainingTitle: string;

  @ApiProperty()
  chapterId: number;

  @ApiProperty()
  chapterTitle: string;

  @ApiProperty()
  sectionId: number;

  @ApiProperty()
  sectionTitle: string;

  @ApiProperty()
  sortOrder: number;
}

export class QuerySectionsByProblemIdResponseDto {
  @ApiProperty({ type: [ProblemReferencedSectionDto] })
  references: ProblemReferencedSectionDto[];
}
