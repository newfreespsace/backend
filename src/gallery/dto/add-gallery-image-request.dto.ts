import { ApiProperty } from "@nestjs/swagger";

import { Type } from "class-transformer";
import { IsIn, IsInt, IsOptional, Length, Min, ValidateNested } from "class-validator";

import { IsValidFilename } from "@/common/validators";
import { FileUploadInfoDto } from "@/file/dto";

export const GALLERY_IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const;
export type GalleryImageMimeType = typeof GALLERY_IMAGE_MIME_TYPES[number];

export class AddGalleryImageRequestDto {
  @ApiProperty()
  @IsValidFilename()
  @Length(1, 256)
  readonly filename: string;

  @ApiProperty({ enum: GALLERY_IMAGE_MIME_TYPES })
  @IsIn(GALLERY_IMAGE_MIME_TYPES)
  readonly mimeType: GalleryImageMimeType;

  @ApiProperty()
  @IsOptional()
  @IsInt()
  @Min(1)
  readonly width?: number;

  @ApiProperty()
  @IsOptional()
  @IsInt()
  @Min(1)
  readonly height?: number;

  @ApiProperty()
  @ValidateNested()
  @Type(() => FileUploadInfoDto)
  readonly uploadInfo: FileUploadInfoDto;
}
