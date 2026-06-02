import { ApiProperty } from "@nestjs/swagger";

import { SignedFileUploadRequestDto } from "@/file/dto";

export enum SubmitResponseError {
  PERMISSION_DENIED = "PERMISSION_DENIED",
  NO_SUCH_PROBLEM = "NO_SUCH_PROBLEM",
  NO_SUCH_CONTEST = "NO_SUCH_CONTEST",
  CONTEST_NOT_RUNNING = "CONTEST_NOT_RUNNING",
  FILE_TOO_LARGE = "FILE_TOO_LARGE",

  // Below only happen when user uploaded the file and call this API twice.
  FILE_UUID_EXISTS = "FILE_UUID_EXISTS",
  FILE_NOT_UPLOADED = "FILE_NOT_UPLOADED"
}

export class SubmitResponseDto {
  @ApiProperty()
  error?: SubmitResponseError;

  @ApiProperty()
  submissionId?: number;

  @ApiProperty()
  signedUploadRequest?: SignedFileUploadRequestDto;
}
