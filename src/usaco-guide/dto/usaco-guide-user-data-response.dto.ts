import { ApiProperty } from "@nestjs/swagger";

export class UsacoGuideUserDataResponseDto {
  @ApiProperty({ nullable: true, type: "object", additionalProperties: true })
  data: Record<string, unknown> | null;

  @ApiProperty()
  schemaVersion: number;

  @ApiProperty()
  revision: number;

  @ApiProperty({ nullable: true })
  updatedAt: Date | null;
}
