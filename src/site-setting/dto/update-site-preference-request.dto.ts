import { ApiProperty } from "@nestjs/swagger";
import { IsObject, IsOptional } from "class-validator";

import { PreferenceConfig } from "@/config/config.schema";

export class UpdateSitePreferenceRequestDto {
  @ApiProperty()
  @IsOptional()
  @IsObject()
  readonly preference: Partial<PreferenceConfig>;
}
