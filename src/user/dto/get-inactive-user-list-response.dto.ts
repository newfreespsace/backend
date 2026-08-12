import { ApiProperty } from "@nestjs/swagger";

import { InactiveUserDto } from "./inactive-user.dto";

export enum GetInactiveUserListResponseError {
  PERMISSION_DENIED = "PERMISSION_DENIED",
  TAKE_TOO_MANY = "TAKE_TOO_MANY"
}

export class GetInactiveUserListResponseDto {
  @ApiProperty({ enum: GetInactiveUserListResponseError })
  error?: GetInactiveUserListResponseError;

  @ApiProperty({ type: [InactiveUserDto] })
  users?: InactiveUserDto[];

  @ApiProperty()
  count?: number;
}
