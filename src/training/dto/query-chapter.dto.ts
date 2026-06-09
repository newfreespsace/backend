import { Type } from "class-transformer";
import { IsNumber } from "class-validator";

export class QueryChapterByTrainingIdDto {
  @Type(() => Number)
  @IsNumber()
  trainingId: number;
}
