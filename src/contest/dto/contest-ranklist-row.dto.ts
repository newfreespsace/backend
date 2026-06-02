import { ApiProperty } from "@nestjs/swagger";

import { UserMetaDto } from "@/user/dto";

export class ContestRanklistRowDto {
  @ApiProperty()
  rank: number;

  @ApiProperty({ type: UserMetaDto })
  user: UserMetaDto;

  @ApiProperty()
  score: number;

  @ApiProperty()
  timeSpent: number;

  @ApiProperty()
  scoreDetails: Record<string, unknown>;
}
