import { ApiProperty } from "@nestjs/swagger";

export class SetCurrentTrainingResponseDto {
  @ApiProperty()
  success: boolean;

  @ApiProperty({ required: false, nullable: true })
  currentTrainingId?: number | null;
}
