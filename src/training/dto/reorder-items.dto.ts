import { Type } from "class-transformer";
import { IsArray, IsInt, ValidateNested } from "class-validator";

class ReorderItemDto {
  @Type(() => Number)
  @IsInt()
  id: number;

  @Type(() => Number)
  @IsInt()
  sortOrder: number;
}

export class ReorderTrainingsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReorderItemDto)
  items: ReorderItemDto[];
}

export class ReorderChaptersDto {
  @Type(() => Number)
  @IsInt()
  trainingId: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReorderItemDto)
  items: ReorderItemDto[];
}

export class ReorderSectionsDto {
  @Type(() => Number)
  @IsInt()
  chapterId: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ReorderItemDto)
  items: ReorderItemDto[];
}
