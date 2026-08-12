import { ApiProperty } from "@nestjs/swagger";

import { IsBoolean, IsInt } from "class-validator";

export class SetUserActiveStatusRequestDto {
  @ApiProperty()
  @IsInt()
  readonly userId: number;

  @ApiProperty()
  @IsBoolean()
  readonly isActive: boolean;
}
