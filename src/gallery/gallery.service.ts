import { Injectable } from "@nestjs/common";
import { InjectDataSource, InjectRepository } from "@nestjs/typeorm";

import { Readable } from "stream";

import { DataSource, EntityManager, Repository } from "typeorm";
import { v4 as UUID } from "uuid";

import { ConfigService } from "@/config/config.service";
import { FileEntity } from "@/file/file.entity";
import { FileService, MinioSignFor } from "@/file/file.service";
import { FileUploadInfoDto, SignedFileUploadRequestDto } from "@/file/dto";
import { LockService } from "@/redis/lock.service";
import { UserEntity } from "@/user/user.entity";

import { GalleryImageEntity } from "./gallery-image.entity";
import { AddGalleryImageResponseError, GalleryImageDto, GalleryImageMimeType, GalleryQuotaDto } from "./dto";

type AddGalleryImageLimitError =
  | AddGalleryImageResponseError.FILE_TOO_LARGE
  | AddGalleryImageResponseError.TOTAL_SIZE_TOO_LARGE
  | AddGalleryImageResponseError.TOO_MANY_IMAGES;

@Injectable()
export class GalleryService {
  constructor(
    @InjectDataSource()
    private readonly connection: DataSource,
    @InjectRepository(GalleryImageEntity)
    private readonly galleryImageRepository: Repository<GalleryImageEntity>,
    private readonly fileService: FileService,
    private readonly configService: ConfigService,
    private readonly lockService: LockService
  ) {}

  private calcQuotaSize(acceptedProblemCount: number): number {
    const config = this.configService.config.resourceLimit;
    return Math.min(
      config.galleryMaxSize,
      config.galleryBaseSize + acceptedProblemCount * config.gallerySizePerAcceptedProblem
    );
  }

  private async getUsedSizeAndCount(ownerId: number, transactionalEntityManager?: EntityManager) {
    const repository = transactionalEntityManager
      ? transactionalEntityManager.getRepository(GalleryImageEntity)
      : this.galleryImageRepository;
    const result = await repository
      .createQueryBuilder("image")
      .select("COALESCE(SUM(image.size), 0)", "usedSize")
      .addSelect("COUNT(*)", "imageCount")
      .where("image.ownerId = :ownerId", { ownerId })
      .getRawOne();

    return {
      usedSize: Number(result.usedSize),
      imageCount: Number(result.imageCount)
    };
  }

  async getQuota(user: UserEntity, transactionalEntityManager?: EntityManager): Promise<GalleryQuotaDto> {
    const { usedSize, imageCount } = await this.getUsedSizeAndCount(user.id, transactionalEntityManager);
    const config = this.configService.config.resourceLimit;
    return {
      acceptedProblemCount: user.acceptedProblemCount,
      usedSize,
      quotaSize: this.calcQuotaSize(user.acceptedProblemCount),
      imageCount,
      maxImageCount: config.galleryImageMaxCount,
      maxImageSize: config.galleryImageMaxSize
    };
  }

  private async checkAddImageLimit(
    user: UserEntity,
    size: number,
    transactionalEntityManager: EntityManager
  ): Promise<AddGalleryImageLimitError> {
    const quota = await this.getQuota(user, transactionalEntityManager);
    if (size > quota.maxImageSize) return AddGalleryImageResponseError.FILE_TOO_LARGE;
    if (quota.imageCount + 1 > quota.maxImageCount) return AddGalleryImageResponseError.TOO_MANY_IMAGES;
    if (quota.usedSize + size > quota.quotaSize) return AddGalleryImageResponseError.TOTAL_SIZE_TOO_LARGE;
    return null;
  }

  async listImages(user: UserEntity): Promise<{ images: GalleryImageDto[]; quota: GalleryQuotaDto }> {
    const [images, quota] = await Promise.all([
      this.galleryImageRepository.find({
        where: { ownerId: user.id },
        order: { createdAt: "DESC", id: "DESC" }
      }),
      this.getQuota(user)
    ]);

    return {
      images: await Promise.all(images.map(image => this.getImageDto(image, true))),
      quota
    };
  }

  async addImage({
    user,
    uploadInfo,
    filename,
    mimeType,
    width,
    height
  }: {
    user: UserEntity;
    uploadInfo: FileUploadInfoDto;
    filename: string;
    mimeType: GalleryImageMimeType;
    width?: number;
    height?: number;
  }): Promise<
    GalleryImageDto | SignedFileUploadRequestDto | AddGalleryImageLimitError | "FILE_UUID_EXISTS" | "FILE_NOT_UPLOADED"
  > {
    return await this.lockService.lock(`ManageGallery_${user.id}`, async () => {
      return await this.connection.transaction("REPEATABLE READ", async transactionalEntityManager => {
        const result = await this.fileService.processUploadRequest(
          uploadInfo,
          async size => await this.checkAddImageLimit(user, size, transactionalEntityManager),
          transactionalEntityManager
        );

        if (!(result instanceof FileEntity)) return result;

        const image = new GalleryImageEntity();
        image.ownerId = user.id;
        image.uuid = result.uuid;
        image.publicId = UUID();
        image.filename = filename;
        image.mimeType = mimeType;
        image.size = result.size;
        image.width = width || null;
        image.height = height || null;
        image.createdAt = new Date();

        await transactionalEntityManager.save(GalleryImageEntity, image);

        return await this.getImageDto(image, true);
      });
    });
  }

  async deleteImage(user: UserEntity, id: number): Promise<boolean> {
    return await this.lockService.lock(`ManageGallery_${user.id}`, async () => {
      let deleteFileActually: () => void = null;
      const deleted = await this.connection.transaction("READ COMMITTED", async transactionalEntityManager => {
        const image = await transactionalEntityManager.findOneBy(GalleryImageEntity, { id, ownerId: user.id });
        if (!image) return false;

        await transactionalEntityManager.delete(GalleryImageEntity, { id: image.id, ownerId: user.id });
        deleteFileActually = await this.fileService.deleteFile(image.uuid, transactionalEntityManager);
        return true;
      });

      if (deleteFileActually) deleteFileActually();
      return deleted;
    });
  }

  private async getImageDto(image: GalleryImageEntity, withDownloadUrl: boolean): Promise<GalleryImageDto> {
    const publicId = await this.ensurePublicId(image);
    return {
      id: image.id,
      publicId,
      filename: image.filename,
      mimeType: image.mimeType,
      size: image.size,
      width: image.width,
      height: image.height,
      createdAt: image.createdAt,
      downloadUrl: withDownloadUrl
        ? await this.fileService.signDownloadLink({
            uuid: image.uuid,
            downloadFilename: image.filename,
            signFor: MinioSignFor.UserDownload
          })
        : undefined
    };
  }

  async getPublicImageContent(publicId: string): Promise<{ image: GalleryImageEntity; stream: Readable }> {
    const image = await this.galleryImageRepository.findOneBy({ publicId });
    if (!image) return null;

    return {
      image,
      stream: await this.fileService.getFileStream(image.uuid)
    };
  }

  private async ensurePublicId(image: GalleryImageEntity): Promise<string> {
    if (image.publicId) return image.publicId;

    image.publicId = image.uuid;
    await this.galleryImageRepository.update({ id: image.id }, { publicId: image.publicId });
    return image.publicId;
  }
}
