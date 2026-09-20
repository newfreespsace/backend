import { Body, Controller, Delete, Get, Put } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "@/common/user.decorator";
import { UserEntity } from "@/user/user.entity";
import { UserService } from "@/user/user.service";

import { UsacoGuideService } from "./usaco-guide.service";

import { SaveUsacoGuideUserDataRequestDto, UsacoGuideUserDataResponseDto, UsacoGuideUserResponseDto } from "./dto";

@ApiTags("USACO Guide")
@ApiBearerAuth()
@Controller("guide")
export class UsacoGuideController {
  constructor(private readonly usacoGuideService: UsacoGuideService, private readonly userService: UserService) {}

  @Get("me")
  @ApiOperation({ summary: "Get the current NSOJ user for USACO Guide." })
  async me(@CurrentUser() currentUser: UserEntity): Promise<UsacoGuideUserResponseDto> {
    const meta = await this.userService.getUserMeta(currentUser, currentUser);
    return {
      id: meta.id,
      username: meta.username,
      nickname: meta.nickname,
      email: meta.email,
      avatar: meta.avatar,
      isAdmin: meta.isAdmin
    };
  }

  @Get("userData")
  @ApiOperation({ summary: "Get the current user's USACO Guide settings and progress." })
  async getUserData(@CurrentUser() currentUser: UserEntity): Promise<UsacoGuideUserDataResponseDto> {
    return await this.usacoGuideService.getUserData(currentUser.id);
  }

  @Put("userData")
  @ApiOperation({ summary: "Replace the current user's USACO Guide settings and progress." })
  async saveUserData(
    @CurrentUser() currentUser: UserEntity,
    @Body() request: SaveUsacoGuideUserDataRequestDto
  ): Promise<UsacoGuideUserDataResponseDto> {
    return await this.usacoGuideService.saveUserData(
      currentUser,
      request.data,
      request.schemaVersion,
      request.expectedRevision
    );
  }

  @Delete("userData")
  @ApiOperation({ summary: "Delete the current user's USACO Guide settings and progress." })
  async deleteUserData(@CurrentUser() currentUser: UserEntity): Promise<Record<string, never>> {
    await this.usacoGuideService.deleteUserData(currentUser.id);
    return {};
  }
}
