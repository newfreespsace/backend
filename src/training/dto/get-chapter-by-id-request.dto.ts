import { Type } from "class-transformer";
import { IsNumber } from "class-validator";

export class GetChapterByIdDto {
  @Type(() => Number)
  @IsNumber()
  id: number;
}
