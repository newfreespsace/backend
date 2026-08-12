import { ApiProperty } from "@nestjs/swagger";

import { UserMetaDto } from "./user-meta.dto";

export enum SetUserActiveStatusResponseError {
  PERMISSION_DENIED = "PERMISSION_DENIED",
  NO_SUCH_USER = "NO_SUCH_USER",
  CANNOT_DEACTIVATE_SELF = "CANNOT_DEACTIVATE_SELF"
}

export class SetUserActiveStatusResponseDto {
  @ApiProperty({ enum: SetUserActiveStatusResponseError })
  error?: SetUserActiveStatusResponseError;

  @ApiProperty()
  meta?: UserMetaDto;
}
