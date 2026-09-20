import { ApiProperty } from "@nestjs/swagger";

import { IsInt, IsObject, IsOptional, Min } from "class-validator";

export class SaveUsacoGuideUserDataRequestDto {
  @ApiProperty({ type: "object", additionalProperties: true })
  @IsObject()
  data: Record<string, unknown>;

  @ApiProperty({ default: 1 })
  @IsInt()
  @Min(1)
  schemaVersion: number;

  @ApiProperty({ required: false, description: "Revision returned by the last read or write." })
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedRevision?: number;
}
