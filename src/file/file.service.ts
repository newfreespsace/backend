import { URL } from "url";
import { Readable } from "stream";
import crypto from "crypto";

import { Injectable, OnModuleInit } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";

import { Repository, EntityManager, In } from "typeorm";
import { v4 as UUID } from "uuid";
import { Client as MinioClient, ClientOptions } from "minio";

import { logger } from "@/logger";
import { ConfigService } from "@/config/config.service";

import { FileEntity } from "./file.entity";

import { FileUploadInfoDto, SignedFileUploadRequestDto } from "./dto";

// 10 minutes upload expire time
const FILE_UPLOAD_EXPIRE_TIME = 10 * 60;
// 20 minutes download expire time
const FILE_DOWNLOAD_EXPIRE_TIME = 20 * 60 * 60;

interface FileObjectKeyOptions {
  objectKeyPrefix?: string;
}

interface ProxyUploadTokenPayload {
  uuid: string;
  size: number;
  objectKeyPrefix?: string;
  expiresAt: number;
}

interface ProxyDownloadTokenPayload {
  uuid: string;
  downloadFilename?: string;
  objectKeyPrefix?: string;
  expiresAt: number;
}

// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/encodeURIComponent
function encodeRFC5987ValueChars(str: string) {
  return (
    encodeURIComponent(str)
      // Note that although RFC3986 reserves "!", RFC5987 does not,
      // so we do not need to escape it
      .replace(/['()]/g, escape) // i.e., %27 %28 %29
      .replace(/\*/g, "%2A")
      // The following are not required for percent-encoding per RFC5987,
      // so we can allow for a little better readability over the wire: |`^
      .replace(/%(?:7C|60|5E)/g, unescape)
  );
}

interface MinioEndpointConfig {
  endPoint: string;
  port: number;
  useSSL: boolean;
}

function parseMainEndpointUrl(endpoint: string): MinioEndpointConfig {
  const url = new URL(endpoint);
  const result: Partial<MinioEndpointConfig> = {};

  if (url.pathname !== "/") throw new Error("Main MinIO endpoint URL of a sub-directory is not supported.");
  if (url.username || url.password || url.hash || url.search)
    throw new Error("Authorization, search parameters and hash are not supported for main MinIO endpoint URL.");

  if (url.protocol === "http:") result.useSSL = false;
  else if (url.protocol === "https:") result.useSSL = true;
  else
    throw new Error(
      `Invalid protocol "${url.protocol}" for main MinIO endpoint URL. Only HTTP and HTTPS are supported.`
    );

  result.endPoint = url.hostname;
  result.port = url.port ? Number(url.port) : result.useSSL ? 443 : 80;

  return result as MinioEndpointConfig;
}

function parseSignEndpointUrl(endpoint: string): (originalUrl: string) => string {
  if (!endpoint) return originalUrl => originalUrl;

  const url = new URL(endpoint);
  if (url.hash || url.search)
    throw new Error("Search parameters and hash are not supported for MinIO sign endpoint URL.");
  if (!url.pathname.endsWith("/")) throw new Error("MinIO sign endpoint URL's pathname must ends with '/'.");

  return originalUrl => {
    const parsedOriginUrl = new URL(originalUrl);
    return new URL(parsedOriginUrl.pathname.slice(1) + parsedOriginUrl.search + parsedOriginUrl.hash, url).toString();
  };
}

export enum MinioSignFor {
  UserUpload = "UserUpload",
  UserDownload = "UserDownload",
  Judge = "Judge"
}

@Injectable()
export class FileService implements OnModuleInit {
  private readonly minioClient: MinioClient;

  private readonly bucket: string;

  private readonly minioSigner: Record<
    MinioSignFor,
    {
      client: MinioClient;
      replaceUrl: (originalUrl: string) => string;
    }
  >;

  constructor(
    @InjectRepository(FileEntity)
    private readonly fileRepository: Repository<FileEntity>,
    private readonly configService: ConfigService
  ) {
    const config = this.configService.config.services.minio;
    const commonOptions: Pick<ClientOptions, "accessKey" | "secretKey" | "region" | "pathStyle"> = {
      accessKey: config.accessKey,
      secretKey: config.secretKey,
      region: "ap-chengdu",
      pathStyle: config.pathStyle ?? false
    };

    this.minioClient = new MinioClient({
      ...parseMainEndpointUrl(config.default.endpoint),
      ...commonOptions
    });
    this.bucket = config.bucket;
    this.minioSigner = {
      [MinioSignFor.UserUpload]: {
        client: new MinioClient({
          ...parseMainEndpointUrl(config?.forUserUpload?.endpoint || config.default.endpoint),
          ...commonOptions
        }),
        replaceUrl: parseSignEndpointUrl(config?.forUserUpload?.urlEndpoint || config.default.urlEndpoint)
      },
      [MinioSignFor.UserDownload]: {
        client: new MinioClient({
          ...parseMainEndpointUrl(config?.forUserDownload?.endpoint || config.default.endpoint),
          ...commonOptions
        }),
        replaceUrl: parseSignEndpointUrl(config?.forUserDownload?.urlEndpoint || config.default.urlEndpoint)
      },
      [MinioSignFor.Judge]: {
        client: new MinioClient({
          ...parseMainEndpointUrl(config?.forJudge?.endpoint || config.default.endpoint),
          ...commonOptions
        }),
        replaceUrl: parseSignEndpointUrl(config?.forJudge?.urlEndpoint || config.default.urlEndpoint)
      }
    };
  }

  fileExistsInMinio(uuid: string): Promise<boolean> {
    return new Promise(resolve =>
      this.minioClient
        .statObject(this.bucket, uuid)
        .then(() => resolve(true))
        .catch(() => resolve(false))
    );
  }

  async uploadFile(
    uuid: string,
    streamOrBufferOrFile: string | Buffer | Readable,
    retryCount = 10,
    options: FileObjectKeyOptions = {}
  ): Promise<void> {
    for (let i = 0; i < retryCount; i++) {
      try {
        /* eslint-disable no-await-in-loop */
        if (typeof streamOrBufferOrFile === "string")
          await this.minioClient.fPutObject(this.bucket, this.getObjectKey(uuid, options), streamOrBufferOrFile, {});
        else await this.minioClient.putObject(this.bucket, this.getObjectKey(uuid, options), streamOrBufferOrFile);
        /* eslint-enable no-await-in-loop */
      } catch (e) {
        if (i === retryCount - 1) throw e;
        else {
          // eslint-disable-next-line no-await-in-loop
          await new Promise(resolve => setTimeout(resolve, 1000));
          continue;
        }
      }
    }
  }

  async onModuleInit(): Promise<void> {
    let bucketExists: boolean;
    try {
      bucketExists = await this.minioClient.bucketExists(this.bucket);
    } catch (e) {
      throw new Error(
        `Error initializing the MinIO client. Please check your configuration file and MinIO server. ${e}`
      );
    }

    if (!bucketExists)
      throw new Error(
        `MinIO bucket ${this.bucket} doesn't exist. Please check your configuration file and MinIO server.`
      );
  }

  /**
   * Process the client's request about uploading a file.
   *
   * * If the user has not uploaded the file, return a signed upload info object.
   * * If the user has uploaded the file, check the file existance, file size and limits.
   *
   * @note
   * The `checkLimit` function may return different result for each call with the same upload info.
   *
   * e.g. When a user uploaded other files before upload this file, the quota is enough before uploading but
   *      not enough after uploading.
   *
   * If the file is checked to be exceeding the limit after uploaded, it will be deleted.
   *
   * @return A `SignedFileUploadRequestDto` to return to the client if the file is not uploaded.
   * @return `string` error message if client says the file is uploaded but we do not accept it according to some errors.
   * @return A `FileEntity` if the file is uploaded successfully and saved to the database.
   */
  async processUploadRequest<LimitCheckErrorType extends string>(
    uploadInfo: FileUploadInfoDto,
    checkLimit: (size: number) => Promise<LimitCheckErrorType> | LimitCheckErrorType,
    transactionalEntityManager: EntityManager,
    options: FileObjectKeyOptions = {}
  ): Promise<FileEntity | SignedFileUploadRequestDto | LimitCheckErrorType | "FILE_UUID_EXISTS" | "FILE_NOT_UPLOADED"> {
    const objectKey = this.getObjectKey(uploadInfo.uuid, options);
    const limitCheckError = await checkLimit(uploadInfo.size);
    if (limitCheckError) {
      if (uploadInfo.uuid) this.deleteUnfinishedUploadedFile(uploadInfo.uuid, options);
      return limitCheckError;
    }

    if (uploadInfo.uuid) {
      // The client says the file is uploaded

      if ((await transactionalEntityManager.countBy(FileEntity, { uuid: uploadInfo.uuid })) !== 0)
        return "FILE_UUID_EXISTS";

      // Check file existance
      try {
        await this.minioClient.statObject(this.bucket, objectKey);
      } catch (e) {
        if (e.message === "The specified key does not exist.") {
          return "FILE_NOT_UPLOADED";
        }
        throw e;
      }

      // Save to the database
      const file = new FileEntity();
      file.uuid = uploadInfo.uuid;
      file.size = uploadInfo.size;
      file.uploadTime = new Date();

      await transactionalEntityManager.save(FileEntity, file);

      return file;
    } else {
      // The client says it want to upload a file for this request

      return await this.signUploadRequest(uploadInfo.size, uploadInfo.size, options);
    }
  }

  /**
   * Sign a upload request for given size. The alternative MinIO endpoint for user will be used in the POST URL.
   */
  private async signUploadRequest(
    minSize?: number,
    maxSize?: number,
    options: FileObjectKeyOptions = {}
  ): Promise<SignedFileUploadRequestDto> {
    const uuid = UUID();

    return {
      uuid,
      method: "POST",
      url: "/api/file/upload",
      extraFormData: {
        token: this.signProxyUploadToken({
          uuid,
          size: maxSize || minSize || 0,
          objectKeyPrefix: options.objectKeyPrefix,
          expiresAt: Date.now() + FILE_UPLOAD_EXPIRE_TIME * 1000
        })
      },
      fileFieldName: "file"
    };
  }

  /**
   * @return A function to run after transaction, to delete the file(s) actually.
   */
  async deleteFile(
    uuid: string | string[],
    transactionalEntityManager: EntityManager,
    options: FileObjectKeyOptions = {}
  ): Promise<() => void> {
    if (typeof uuid === "string") {
      await transactionalEntityManager.delete(FileEntity, { uuid });
      return () =>
        this.minioClient.removeObject(this.bucket, this.getObjectKey(uuid, options)).catch(e => {
          logger.error(`Failed to delete file ${uuid}: ${e}`);
        });
    }
    if (uuid.length > 0) {
      await transactionalEntityManager.delete(FileEntity, { uuid: In(uuid) });
      return () =>
        this.minioClient
          .removeObjects(
            this.bucket,
            uuid.map(fileUuid => this.getObjectKey(fileUuid, options))
          )
          .catch(e => {
            logger.error(`Failed to delete file [${uuid}]: ${e}`);
          });
    }
    return () => {
      /* do nothing */
    };
  }

  /**
   * Delete a user-uploaded file before calling finishUpload()
   */
  deleteUnfinishedUploadedFile(uuid: string, options: FileObjectKeyOptions = {}): void {
    this.minioClient.removeObject(this.bucket, this.getObjectKey(uuid, options)).catch(e => {
      if (e.message === "The specified key does not exist.") return;
      logger.error(`Failed to delete unfinished uploaded file ${uuid}: ${e}`);
    });
  }

  async getFileSizes(uuids: string[], transcationalEntityManager: EntityManager): Promise<number[]> {
    if (uuids.length === 0) return [];
    const uniqueUuids = Array.from(new Set(uuids));
    const files = await transcationalEntityManager.findBy(FileEntity, {
      uuid: In(uniqueUuids)
    });
    const map = Object.fromEntries(files.map(file => [file.uuid, file]));
    return uuids.map(uuid => map[uuid].size);
  }

  async signDownloadLink({
    uuid,
    downloadFilename,
    noExpire,
    signFor,
    objectKeyPrefix
  }: {
    uuid: string;
    downloadFilename?: string;
    noExpire?: boolean;
    signFor?: MinioSignFor;
    objectKeyPrefix?: string;
  }): Promise<string> {
    const client = signFor ? this.minioSigner[signFor].client : this.minioClient;
    const url = await client.presignedGetObject(
      this.bucket,
      this.getObjectKey(uuid, { objectKeyPrefix }),
      // The maximum expire time is 7 days
      noExpire ? 24 * 60 * 60 * 7 : FILE_DOWNLOAD_EXPIRE_TIME,
      !downloadFilename
        ? {}
        : {
            "response-content-disposition": `attachment; filename="${encodeRFC5987ValueChars(downloadFilename)}"`
          }
    );

    if (signFor) return this.minioSigner[signFor].replaceUrl(url);
    else return url;
  }

  async signProxyDownloadLink({
    uuid,
    downloadFilename,
    noExpire,
    objectKeyPrefix
  }: {
    uuid: string;
    downloadFilename?: string;
    noExpire?: boolean;
    objectKeyPrefix?: string;
  }): Promise<string> {
    const token = this.signProxyDownloadToken({
      uuid,
      downloadFilename,
      objectKeyPrefix,
      expiresAt: Date.now() + (noExpire ? 24 * 60 * 60 * 7 : FILE_DOWNLOAD_EXPIRE_TIME) * 1000
    });
    return `/api/file/download?token=${encodeURIComponent(token)}`;
  }

  verifyProxyUploadToken(token: string): ProxyUploadTokenPayload {
    return this.verifyProxyToken<ProxyUploadTokenPayload>(token);
  }

  verifyProxyDownloadToken(token: string): ProxyDownloadTokenPayload {
    return this.verifyProxyToken<ProxyDownloadTokenPayload>(token);
  }

  async getFileStream(uuid: string): Promise<Readable> {
    return await this.minioClient.getObject(this.bucket, uuid);
  }

  async getFileStreamByObjectKey(uuid: string, options: FileObjectKeyOptions = {}): Promise<Readable> {
    return await this.minioClient.getObject(this.bucket, this.getObjectKey(uuid, options));
  }

  async getProxyDownloadStream(token: string): Promise<{ stream: Readable; downloadFilename?: string }> {
    const payload = this.verifyProxyDownloadToken(token);
    return {
      stream: await this.getFileStreamByObjectKey(payload.uuid, { objectKeyPrefix: payload.objectKeyPrefix }),
      downloadFilename: payload.downloadFilename
    };
  }

  async runMaintainceTasks(): Promise<void> {
    // Delete unused files
    const stream = this.minioClient.listObjectsV2(this.bucket);
    const deleteList: string[] = [];
    await new Promise((resolve, reject) => {
      const promises: Promise<void>[] = [];
      stream.on("data", object => {
        promises.push(
          (async () => {
            const uuid = object.name;
            if (!(await this.fileRepository.countBy({ uuid: this.getFileUuidFromObjectKey(uuid) }))) {
              deleteList.push(uuid);
            }
          })()
        );
      });
      stream.on("end", () => Promise.all(promises).then(resolve).catch(reject));
      stream.on("error", reject);
    });
    await this.minioClient.removeObjects(this.bucket, deleteList);
  }

  private getObjectKey(uuid: string, { objectKeyPrefix }: FileObjectKeyOptions = {}): string {
    if (!uuid) return uuid;
    return objectKeyPrefix ? `${objectKeyPrefix}${uuid}` : uuid;
  }

  private getFileUuidFromObjectKey(objectKey: string): string {
    if (objectKey.startsWith("gallery-images/")) return objectKey.slice("gallery-images/".length);
    return objectKey;
  }

  private signProxyUploadToken(payload: ProxyUploadTokenPayload): string {
    return this.signProxyToken(payload);
  }

  private signProxyDownloadToken(payload: ProxyDownloadTokenPayload): string {
    return this.signProxyToken(payload);
  }

  private signProxyToken(payload: ProxyUploadTokenPayload | ProxyDownloadTokenPayload): string {
    const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = crypto
      .createHmac("sha256", this.configService.config.security.sessionSecret)
      .update(encodedPayload)
      .digest("base64url");
    return `${encodedPayload}.${signature}`;
  }

  private verifyProxyToken<T extends { expiresAt: number }>(token: string): T {
    const [encodedPayload, signature] = token.split(".");
    if (!encodedPayload || !signature) throw new Error("Invalid file token.");

    const expectedSignature = crypto
      .createHmac("sha256", this.configService.config.security.sessionSecret)
      .update(encodedPayload)
      .digest("base64url");
    const signatureBuffer = Buffer.from(signature);
    const expectedSignatureBuffer = Buffer.from(expectedSignature);
    if (
      signatureBuffer.length !== expectedSignatureBuffer.length ||
      !crypto.timingSafeEqual(signatureBuffer, expectedSignatureBuffer)
    )
      throw new Error("Invalid file token.");

    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf-8")) as T;
    if (payload.expiresAt < Date.now()) throw new Error("File token expired.");
    return payload;
  }
}
