import { ApiProperty } from "@nestjs/swagger";

import { IsInt, IsOptional, Min } from "class-validator";

export class ListActiveUsersRequestDto {
  @ApiProperty({ required: false })
  @IsInt()
  @Min(0)
  @IsOptional()
  sinceTime?: number;

  @ApiProperty({ required: false })
  @IsInt()
  @Min(1)
  @IsOptional()
  takeCount?: number;
}
