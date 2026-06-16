import { ApiProperty } from "@nestjs/swagger";

import { IsInt, IsOptional } from "class-validator";

export class SetCurrentTrainingDto {
  @ApiProperty({ required: false, nullable: true })
  @IsOptional()
  @IsInt()
  trainingId?: number | null;
}
