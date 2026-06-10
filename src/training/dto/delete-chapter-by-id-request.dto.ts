import { Type } from "class-transformer";
import { IsNumber } from "class-validator";

export class DeleteChapterByIdRequestDto {
  @Type(() => Number)
  @IsNumber()
  id: number;
}
