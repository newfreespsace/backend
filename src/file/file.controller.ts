import { Controller, Get, Query, Res } from "@nestjs/common";
import { ApiExcludeEndpoint } from "@nestjs/swagger";
import { Response } from "express";

import { FileService } from "./file.service";

function encodeContentDispositionFilename(filename: string): string {
  return encodeURIComponent(filename).replace(/['()]/g, escape).replace(/\*/g, "%2A");
}

@Controller("file")
export class FileController {
  constructor(private readonly fileService: FileService) {}

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
