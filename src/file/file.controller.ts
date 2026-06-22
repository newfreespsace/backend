import fs from "fs-extra";

import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Res,
  UploadedFile,
  UseInterceptors
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import { ApiExcludeEndpoint } from "@nestjs/swagger";
import { Response } from "express";

import { FileService } from "./file.service";

const UPLOAD_PROXY_TEMP_DIR = "/tmp/lyrio-upload-proxy";
const UPLOAD_PROXY_MAX_FILE_SIZE = 1024 * 1024 * 1024;

fs.ensureDirSync(UPLOAD_PROXY_TEMP_DIR);

function encodeContentDispositionFilename(filename: string): string {
  return encodeURIComponent(filename).replace(/['()]/g, escape).replace(/\*/g, "%2A");
}

@Controller("file")
export class FileController {
  constructor(private readonly fileService: FileService) {}

  @Post("upload")
  @HttpCode(204)
  @ApiExcludeEndpoint()
  @UseInterceptors(
    FileInterceptor("file", {
      dest: UPLOAD_PROXY_TEMP_DIR,
      limits: { fileSize: UPLOAD_PROXY_MAX_FILE_SIZE }
    })
  )
  async upload(@Body("token") token: string, @UploadedFile() file: any): Promise<void> {
    if (!token || !file) throw new BadRequestException("Invalid upload request.");

    let payload: ReturnType<FileService["verifyProxyUploadToken"]>;
    try {
      payload = this.fileService.verifyProxyUploadToken(token);
    } catch (e) {
      throw new BadRequestException("Invalid upload token.");
    }

    try {
      if (file.size !== payload.size) throw new BadRequestException("Invalid file size.");
      await this.fileService.uploadFile(payload.uuid, file.path, 10, {
        objectKeyPrefix: payload.objectKeyPrefix
      });
    } finally {
      if (file.path) await fs.remove(file.path);
    }
  }

  @Get("download")
  @ApiExcludeEndpoint()
  async download(@Query("token") token: string, @Res() response: Response): Promise<void> {
    if (!token) {
      response.status(400).send("Invalid download request");
      return;
    }

    let content: Awaited<ReturnType<FileService["getProxyDownloadStream"]>>;
    try {
      content = await this.fileService.getProxyDownloadStream(token);
    } catch (e) {
      response.status(404).send("File not found");
      return;
    }

    if (content.downloadFilename) {
      response.setHeader(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeContentDispositionFilename(content.downloadFilename)}`
      );
    }
    content.stream.on("error", () => {
      if (!response.headersSent) response.status(500).send("Failed to read file");
      else response.end();
    });
    content.stream.pipe(response);
  }
}
