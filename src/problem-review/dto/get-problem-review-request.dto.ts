import { ApiProperty } from "@nestjs/swagger";

import { IsInt, Min } from "class-validator";

export class GetProblemReviewRequestDto {
  @ApiProperty()
  @IsInt()
  @Min(1)
  problemId: number;
}
