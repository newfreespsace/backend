import { ApiProperty } from "@nestjs/swagger";

import { UserPrivilegeType } from "@/user/user-privilege.service";

import { PreferenceConfig } from "@/config/config.schema";

import { UserMetaDto, UserPreferenceDto } from "@/user/dto";
import { ContestMetaDto } from "@/contest/dto";

export class ServerVersionDto {
  @ApiProperty()
  hash: string;

  @ApiProperty()
  date: string;
}

export class GetSessionInfoResponseDto {
  @ApiProperty()
  userMeta?: UserMetaDto;

  @ApiProperty()
  joinedGroupsCount?: number;

  @ApiProperty({ enum: UserPrivilegeType, isArray: true })
  userPrivileges?: UserPrivilegeType[];

  @ApiProperty()
  userPreference?: UserPreferenceDto;

  @ApiProperty({ type: [ContestMetaDto] })
  activeGroupContests?: ContestMetaDto[];

  @ApiProperty()
  serverPreference: PreferenceConfig;

  @ApiProperty()
  serverVersion: ServerVersionDto;
}
