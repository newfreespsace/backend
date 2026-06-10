// src/training/dto/add-problem-to-section-response.dto.ts

import { ApiProperty } from "@nestjs/swagger";

export class AddProblemToSectionResponseDto {
  @ApiProperty()
  id: number;

  @ApiProperty()
  sectionId: number;

  @ApiProperty()
  problemId: number;

  @ApiProperty()
  sortOrder: number;
}
