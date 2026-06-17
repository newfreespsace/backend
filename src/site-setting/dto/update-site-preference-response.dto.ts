import { ApiProperty } from "@nestjs/swagger";

import { PreferenceConfig } from "@/config/config.schema";

export enum UpdateSitePreferenceResponseError {
  PERMISSION_DENIED = "PERMISSION_DENIED"
}

export class UpdateSitePreferenceResponseDto {
  @ApiProperty({ enum: UpdateSitePreferenceResponseError })
  error?: UpdateSitePreferenceResponseError;

  @ApiProperty()
  preference?: PreferenceConfig;
}