import { ApiProperty } from "@nestjs/swagger";

import { IsInt } from "class-validator";

export class DeleteGalleryImageRequestDto {
  @ApiProperty()
  @IsInt()
  readonly id: number;
}
