import { Type } from "class-transformer";
import { IsNumber } from "class-validator";

export class DeleteByIdRequestDto {
  @Type(() => Number)
  @IsNumber()
  id: number;
}
