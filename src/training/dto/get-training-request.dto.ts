import { ApiProperty } from "@nestjs/swagger";

import { Type } from "class-transformer";
import { IsNumber } from "class-validator";

export class GetTrainingRequestDto {
  @ApiProperty()
  @Type(() => Number)
  @IsNumber()
  id: number;
}
