import { Type } from "class-transformer";
import { IsNumber } from "class-validator";

export class QuerySectionByChapterIdDto {
  @Type(() => Number)
  @IsNumber()
  chapterId: number;
}
