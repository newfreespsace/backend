import { ApiProperty } from "@nestjs/swagger";

import { UserMetaDto } from "@/user/dto";

export enum ListActiveUsersResponseError {
  PERMISSION_DENIED = "PERMISSION_DENIED",
  TAKE_TOO_MANY = "TAKE_TOO_MANY"
}

export class ActiveUserDto {
  @ApiProperty()
  user: UserMetaDto;

  @ApiProperty()
  lastAccessTime: number;
}

export class ListActiveUsersResponseDto {
  @ApiProperty({ enum: ListActiveUsersResponseError })
  error?: ListActiveUsersResponseError;

  @ApiProperty({ type: [ActiveUserDto] })
  users?: ActiveUserDto[];
}
