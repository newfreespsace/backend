import { ApiProperty } from "@nestjs/swagger";

import { ProblemMetaDto } from "@/problem/dto";

export class ContestProblemDto {
  @ApiProperty({ type: ProblemMetaDto })
  meta: ProblemMetaDto;

  @ApiProperty()
  title: string;

  @ApiProperty()
  status?: string;

  @ApiProperty()
  score?: number;

  @ApiProperty()
  submissionId?: number;

  @ApiProperty()
  accepted?: boolean;

  @ApiProperty()
  unacceptedCount?: number;

  @ApiProperty()
  statistics?: {
    attempt: number;
    accepted: number;
    partially?: number;
  };
}
