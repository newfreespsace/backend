import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

import { UserMetaDto } from "./user-meta.dto";

export enum GetUserListResponseError {
  TAKE_TOO_MANY = "TAKE_TOO_MANY"
}

export class UserListItemDto extends UserMetaDto {
  @ApiPropertyOptional()
  successfulHackCount?: number;
}

export class GetUserListResponseDto {
  @ApiProperty()
  error?: GetUserListResponseError;

  @ApiProperty({ type: [UserListItemDto] })
  userMetas?: UserListItemDto[];

  @ApiProperty()
  count?: number;
}
