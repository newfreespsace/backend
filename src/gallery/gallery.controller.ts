import { Body, Controller, Get, Param, Post, Res } from "@nestjs/common";
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Recaptcha } from "@nestlab/google-recaptcha";
import { Response } from "express";

import { CurrentUser } from "@/common/user.decorator";
import { UserEntity } from "@/user/user.entity";

import { GalleryService } from "./gallery.service";
import {
  AddGalleryImageRequestDto,
  AddGalleryImageResponseDto,
  AddGalleryImageResponseError,
  DeleteGalleryImageRequestDto,
  DeleteGalleryImageResponseDto,
  DeleteGalleryImageResponseError,
  GetGalleryQuotaResponseDto,
  GetGalleryQuotaResponseError,
  ListGalleryImagesResponseDto,
  ListGalleryImagesResponseError
} from "./dto";

@ApiTags("Gallery")
@Controller("gallery")
export class GalleryController {
  constructor(private readonly galleryService: GalleryService) {}

  @Post("listImages")
  @ApiBearerAuth()
  @ApiOperation({ summary: "List current user's gallery images." })
  async listImages(@CurrentUser() currentUser: UserEntity): Promise<ListGalleryImagesResponseDto> {
    if (!currentUser) return { error: ListGalleryImagesResponseError.PERMISSION_DENIED };

    return await this.galleryService.listImages(currentUser);
  }

  @Post("getQuota")
  @ApiBearerAuth()
  @ApiOperation({ summary: "Get current user's gallery quota." })
  async getQuota(@CurrentUser() currentUser: UserEntity): Promise<GetGalleryQuotaResponseDto> {
    if (!currentUser) return { error: GetGalleryQuotaResponseError.PERMISSION_DENIED };

    return {
      quota: await this.galleryService.getQuota(currentUser)
    };
  }

  @Recaptcha()
  @Post("addImage")
  @ApiBearerAuth()
  @ApiOperation({
    summary: "Upload an image to current user's gallery.",
    description: "Recaptcha required."
  })
  async addImage(
    @CurrentUser() currentUser: UserEntity,
    @Body() request: AddGalleryImageRequestDto
  ): Promise<AddGalleryImageResponseDto> {
    if (!currentUser) return { error: AddGalleryImageResponseError.PERMISSION_DENIED };

    const result = await this.galleryService.addImage({
      user: currentUser,
      uploadInfo: request.uploadInfo,
      filename: request.filename,
      mimeType: request.mimeType,
      width: request.width,
      height: request.height
    });

    if (typeof result === "string") return { error: result as AddGalleryImageResponseError };
    if ("url" in result) return { signedUploadRequest: result };
    return { image: result };
  }

  @Post("deleteImage")
  @ApiBearerAuth()
  @ApiOperation({ summary: "Delete an image from current user's gallery." })
  async deleteImage(
    @CurrentUser() currentUser: UserEntity,
    @Body() request: DeleteGalleryImageRequestDto
  ): Promise<DeleteGalleryImageResponseDto> {
    if (!currentUser) return { error: DeleteGalleryImageResponseError.PERMISSION_DENIED };

    if (!(await this.galleryService.deleteImage(currentUser, request.id))) {
      return { error: DeleteGalleryImageResponseError.NO_SUCH_IMAGE };
    }

    return {};
  }

  @Get("image/:publicId")
  @ApiExcludeEndpoint()
  async getPublicImage(@Param("publicId") publicId: string, @Res() response: Response): Promise<void> {
    await this.sendPublicImage(publicId, response);
  }

  @Get("image/:publicId/:filename")
  @ApiExcludeEndpoint()
  async getPublicImageWithFilename(@Param("publicId") publicId: string, @Res() response: Response): Promise<void> {
    await this.sendPublicImage(publicId, response);
  }

  private async sendPublicImage(publicId: string, response: Response): Promise<void> {
    const content = await this.galleryService.getPublicImageContent(publicId);
    if (!content) {
      response.status(404).send("Image not found");
      return;
    }

    response.setHeader("Content-Type", content.image.mimeType);
    response.setHeader("Content-Length", String(content.image.size));
    response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    content.stream.on("error", () => {
      if (!response.headersSent) response.status(500).send("Failed to read image");
      else response.end();
    });
    content.stream.pipe(response);
  }
}
