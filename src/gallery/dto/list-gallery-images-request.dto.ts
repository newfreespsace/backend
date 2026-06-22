import { ApiProperty } from "@nestjs/swagger";

import { IsInt, Max, Min } from "class-validator";

export class ListGalleryImagesRequestDto {
  @ApiProperty()
  @IsInt()
  @Min(0)
  skipCount: number;

  @ApiProperty()
  @IsInt()
  @Min(1)
  @Max(100)
  takeCount: number;
}
