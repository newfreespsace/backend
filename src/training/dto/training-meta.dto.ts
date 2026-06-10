import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

import { Type } from "class-transformer";

export class SectionMetaDto {
  @Type(() => Number)
  @ApiProperty()
  id: number;

  @Type(() => Number)
  @ApiProperty()
  chapterId: number;

  @ApiProperty()
  title: string;

  @ApiPropertyOptional()
  description?: string;

  @Type(() => Number)
  @ApiProperty()
  sortOrder: number;
}

export class ChapterMetaDto {
  @Type(() => Number)
  @ApiProperty()
  id: number;

  @Type(() => Number)
  @ApiProperty()
  trainingId: number;

  @ApiProperty()
  title: string;

  @ApiPropertyOptional()
  description?: string;

  @Type(() => Number)
  @ApiProperty()
  sortOrder: number;

  @ApiPropertyOptional({ type: [SectionMetaDto] })
  sections?: SectionMetaDto[];
}

export class TrainingMetaDto {
  @Type(() => Number)
  @ApiProperty()
  id: number;

  @ApiProperty()
  title: string;

  @ApiPropertyOptional()
  description?: string;

  @Type(() => Number)
  @ApiProperty()
  sortOrder: number;

  @ApiPropertyOptional({ type: [ChapterMetaDto] })
  chapters?: ChapterMetaDto[];
}
