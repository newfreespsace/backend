import { ApiProperty } from "@nestjs/swagger";

import { GalleryImageDto } from "./gallery-image.dto";
import { GalleryQuotaDto } from "./gallery-quota.dto";

export enum ListGalleryImagesResponseError {
  PERMISSION_DENIED = "PERMISSION_DENIED"
}

export class ListGalleryImagesResponseDto {
  @ApiProperty()
  error?: ListGalleryImagesResponseError;

  @ApiProperty()
  images?: GalleryImageDto[];

  @ApiProperty()
  quota?: GalleryQuotaDto;
}
