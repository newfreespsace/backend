import { ApiProperty } from "@nestjs/swagger";
import { IsBoolean, IsInt, IsOptional, Max, Min } from "class-validator";

export class QueryContestsRequestDto {
  @ApiProperty()
  @IsInt()
  @Min(0)
  skipCount: number;

  @ApiProperty()
  @IsInt()
  @Min(1)
  @Max(100)
  takeCount: number;

  @ApiProperty()
  @IsOptional()
  @IsBoolean()
  nonpublic?: boolean;
}
