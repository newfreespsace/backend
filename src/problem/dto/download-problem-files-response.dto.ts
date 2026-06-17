import { ApiProperty } from "@nestjs/swagger";

export enum DownloadProblemFilesResponseError {
  NO_SUCH_PROBLEM = "NO_SUCH_PROBLEM",
  PERMISSION_DENIED = "PERMISSION_DENIED",
  DAILY_DOWNLOAD_LIMIT_EXCEEDED = "DAILY_DOWNLOAD_LIMIT_EXCEEDED"
}

export class ProblemFileDownloadInfoDto {
  filename: string;

  downloadUrl: string;
}

export class DownloadProblemFilesResponseDto {
  @ApiProperty()
  error?: DownloadProblemFilesResponseError;

  @ApiProperty({ type: ProblemFileDownloadInfoDto, isArray: true })
  downloadInfo?: ProblemFileDownloadInfoDto[];

  @ApiProperty()
  remainingTestdataDownloads?: number;
}
