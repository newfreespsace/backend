import { ApiProperty } from "@nestjs/swagger";

import { IsInt, Min } from "class-validator";

export class GetInactiveUserListRequestDto {
  @ApiProperty()
  @IsInt()
  @Min(0)
  skipCount: number;

  @ApiProperty()
  @IsInt()
  @Min(1)
  takeCount: number;
}
