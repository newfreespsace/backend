import { ApiProperty } from "@nestjs/swagger";

import { PreferenceConfig } from "@/config/config.schema";

export enum GetSitePreferenceResponseError {
  PERMISSION_DENIED = "PERMISSION_DENIED"
}

export class GetSitePreferenceResponseDto {
  @ApiProperty({ enum: GetSitePreferenceResponseError })
  error?: GetSitePreferenceResponseError;

  @ApiProperty()
  preference?: PreferenceConfig;
}