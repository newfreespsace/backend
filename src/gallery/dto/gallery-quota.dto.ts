import { ApiProperty } from "@nestjs/swagger";

export class GalleryQuotaDto {
  @ApiProperty()
  acceptedProblemCount: number;

  @ApiProperty()
  usedSize: number;

  @ApiProperty()
  quotaSize: number;

  @ApiProperty()
  imageCount: number;

  @ApiProperty()
  maxImageCount: number;

  @ApiProperty()
  maxImageSize: number;
}
