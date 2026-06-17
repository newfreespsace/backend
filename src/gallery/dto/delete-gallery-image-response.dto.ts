import { ApiProperty } from "@nestjs/swagger";

export enum DeleteGalleryImageResponseError {
  PERMISSION_DENIED = "PERMISSION_DENIED",
  NO_SUCH_IMAGE = "NO_SUCH_IMAGE"
}

export class DeleteGalleryImageResponseDto {
  @ApiProperty()
  error?: DeleteGalleryImageResponseError;
}
