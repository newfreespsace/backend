import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
  ValidateNested
} from "class-validator";

export class QueryNotificationsDto {
  @IsInt()
  @Min(0)
  skip = 0;

  @IsInt()
  @Min(1)
  @Max(50)
  take = 20;

  @IsBoolean()
  unreadOnly = false;
}

export class ReadNotificationDto {
  @IsOptional()
  @IsUUID()
  id?: string;

  @IsBoolean()
  all = false;
}

export class SendNotificationDto {
  @IsString()
  @Length(1, 10000)
  body: string;

  @IsString()
  @MaxLength(500)
  targetPath = "";

  @IsIn(["all", "users", "group"])
  audience: "all" | "users" | "group";

  @IsArray()
  @ArrayMaxSize(500)
  @ArrayUnique()
  @IsString({ each: true })
  @Length(1, 24, { each: true })
  usernames: string[] = [];

  @IsOptional()
  @IsInt()
  @Min(1)
  groupId?: number;

  @IsBoolean()
  push = false;

  // Retries of the same submission must not duplicate a broadcast.
  @IsUUID()
  requestId: string;
}

export class PushKeysDto {
  @IsString()
  @Length(80, 120)
  p256dh: string;

  @IsString()
  @Length(20, 32)
  auth: string;
}

export class BindPushDto {
  @IsString()
  @Length(1, 2048)
  endpoint: string;

  @ValidateNested()
  @Type(() => PushKeysDto)
  keys: PushKeysDto;
}

export class DisablePushDto {
  @IsUUID()
  id: string;
}
