import { ApiProperty } from "@nestjs/swagger";

import { GalleryQuotaDto } from "./gallery-quota.dto";

export enum GetGalleryQuotaResponseError {
  PERMISSION_DENIED = "PERMISSION_DENIED"
}

export class GetGalleryQuotaResponseDto {
  @ApiProperty()
  error?: GetGalleryQuotaResponseError;

  @ApiProperty()
  quota?: GalleryQuotaDto;
}
