import { ApiProperty } from "@nestjs/swagger";

import { SignedFileUploadRequestDto } from "@/file/dto";

import { GalleryImageDto } from "./gallery-image.dto";

export enum AddGalleryImageResponseError {
  PERMISSION_DENIED = "PERMISSION_DENIED",
  FILE_TOO_LARGE = "FILE_TOO_LARGE",
  TOTAL_SIZE_TOO_LARGE = "TOTAL_SIZE_TOO_LARGE",
  TOO_MANY_IMAGES = "TOO_MANY_IMAGES",
  INVALID_IMAGE_TYPE = "INVALID_IMAGE_TYPE",
  FILE_UUID_EXISTS = "FILE_UUID_EXISTS",
  FILE_NOT_UPLOADED = "FILE_NOT_UPLOADED"
}

export class AddGalleryImageResponseDto {
  @ApiProperty()
  error?: AddGalleryImageResponseError;

  @ApiProperty()
  signedUploadRequest?: SignedFileUploadRequestDto;

  @ApiProperty()
  image?: GalleryImageDto;
}
