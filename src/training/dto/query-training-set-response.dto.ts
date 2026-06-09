import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class QueryTrainingSetResponseItemDto {
  @ApiProperty()
  id: number;

  @ApiProperty()
  title: string;

  @ApiPropertyOptional()
  description?: string;

  @ApiProperty()
  sortOrder: number;
}

export class QueryTrainingSetResponseDto {
  @ApiProperty({ type: [QueryTrainingSetResponseItemDto] })
  result: QueryTrainingSetResponseItemDto[];

  @ApiProperty()
  count: number;
}
