import { ApiProperty } from "@nestjs/swagger";

export class SetSectionProblemsResponseDto {
  @ApiProperty()
  success: boolean;
}
