import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class SectionMetaDto {
  @ApiProperty()
  id: number;

  @ApiProperty()
  chapterId: number;

  @ApiProperty()
  title: string;

  @ApiPropertyOptional()
  description?: string;

  @ApiProperty()
  sortOrder: number;
}

export class ChapterMetaDto {
  @ApiProperty()
  id: number;

  @ApiProperty()
  trainingId: number;

  @ApiProperty()
  title: string;

  @ApiPropertyOptional()
  description?: string;

  @ApiProperty()
  sortOrder: number;

  @ApiPropertyOptional({ type: [SectionMetaDto] })
  sections?: SectionMetaDto[];
}

export class TrainingMetaDto {
  @ApiProperty()
  id: number;

  @ApiProperty()
  title: string;

  @ApiPropertyOptional()
  description?: string;

  @ApiProperty()
  sortOrder: number;

  @ApiPropertyOptional({ type: [ChapterMetaDto] })
  chapters?: ChapterMetaDto[];
}
