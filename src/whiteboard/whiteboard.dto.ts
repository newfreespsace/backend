import { IsInt, IsString, IsUUID, Max, MaxLength, Min, MinLength } from "class-validator";

export class WhiteboardIdDto {
  @IsUUID("4")
  id: string;
}

export class WhiteboardVersionDto extends WhiteboardIdDto {
  @IsInt()
  @Min(0)
  @Max(2147483646)
  version: number;
}

export class SaveWhiteboardDto extends WhiteboardVersionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title: string;

  @IsString()
  @MaxLength(10 * 1024 * 1024)
  scene: string;
}
