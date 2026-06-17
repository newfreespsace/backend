import { ApiProperty } from "@nestjs/swagger";

export class GalleryImageDto {
  @ApiProperty()
  id: number;

  @ApiProperty()
  publicId: string;

  @ApiProperty()
  filename: string;

  @ApiProperty()
  mimeType: string;

  @ApiProperty()
  size: number;

  @ApiProperty()
  width?: number;

  @ApiProperty()
  height?: number;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  downloadUrl?: string;
}
