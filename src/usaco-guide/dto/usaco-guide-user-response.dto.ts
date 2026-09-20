import { ApiProperty } from "@nestjs/swagger";

import { UserAvatarDto } from "@/user/dto";

export class UsacoGuideUserResponseDto {
  @ApiProperty()
  id: number;

  @ApiProperty()
  username: string;

  @ApiProperty()
  nickname: string;

  @ApiProperty()
  email: string;

  @ApiProperty()
  avatar: UserAvatarDto;

  @ApiProperty()
  isAdmin: boolean;
}
