import { ApiProperty } from "@nestjs/swagger";

import { Locale } from "@/common/locale.type";

import { SubmissionMethod } from "@/remote-judge/remote-judge.types";

import { ProblemType } from "../problem.entity";

export class RemoteProblemDto {
  @ApiProperty()
  contestId: string;

  @ApiProperty()
  taskId: string;

  @ApiProperty()
  url: string;

  @ApiProperty({ required: false })
  fullScore?: number;
}

export class ProblemMetaDto {
  @ApiProperty({ enum: SubmissionMethod })
  submissionMethod: SubmissionMethod;

  @ApiProperty({ type: RemoteProblemDto, required: false })
  remoteProblem?: RemoteProblemDto;

  @ApiProperty()
  id: number;

  @ApiProperty()
  displayId?: number;

  @ApiProperty()
  type: ProblemType;

  @ApiProperty()
  isPublic: boolean;

  @ApiProperty()
  publicTime: Date;

  @ApiProperty()
  ownerId: number;

  @ApiProperty({ enum: Locale, isArray: true })
  locales: Locale[];

  @ApiProperty()
  submissionCount?: number;

  @ApiProperty()
  acceptedSubmissionCount?: number;

  @ApiProperty({ required: false, minimum: 1, maximum: 5 })
  difficulty?: number;
}
