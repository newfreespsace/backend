import { ApiProperty } from "@nestjs/swagger";

import { ContestType } from "../contest.entity";

export class ContestMetaDto {
  @ApiProperty()
  id: number;

  @ApiProperty()
  title: string;

  @ApiProperty()
  subtitle: string;

  @ApiProperty()
  information: string;

  @ApiProperty()
  startTime: Date;

  @ApiProperty()
  endTime: Date;

  @ApiProperty({ enum: ContestType })
  type: ContestType;

  @ApiProperty()
  isPublic: boolean;

  @ApiProperty()
  hideStatistics: boolean;

  @ApiProperty()
  holderId: number;

  @ApiProperty({ type: [Number] })
  problemIds: number[];

  @ApiProperty({ type: [Number] })
  adminIds: number[];

  @ApiProperty()
  rankingParams: Record<string, number>;
}
