import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

import { Type } from "class-transformer";

export class QueryTrainingSetResponseItemDto {
  @ApiProperty()
  id: number;

  @ApiProperty()
  title: string;

  @ApiPropertyOptional()
  description?: string;

  @ApiProperty()
  sortOrder: number;

  @Type(() => Number)
  @ApiProperty()
  problemCount: number;

  @Type(() => Number)
  @ApiProperty()
  acceptedProblemCount: number;
}

export class QueryTrainingSetResponseDto {
  @ApiProperty({ type: [QueryTrainingSetResponseItemDto] })
  result: QueryTrainingSetResponseItemDto[];

  @ApiProperty()
  count: number;
}
