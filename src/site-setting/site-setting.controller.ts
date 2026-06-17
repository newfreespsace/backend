import { Body, Controller, Get, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "@/common/user.decorator";
import { UserEntity } from "@/user/user.entity";

import { SiteSettingService } from "./site-setting.service";
import {
  GetSitePreferenceResponseDto,
  GetSitePreferenceResponseError,
  UpdateSitePreferenceRequestDto,
  UpdateSitePreferenceResponseDto,
  UpdateSitePreferenceResponseError
} from "./dto";

@ApiTags("SiteSetting")
@Controller("site-setting")
export class SiteSettingController {
  constructor(private readonly siteSettingService: SiteSettingService) {}

  @Get("preference")
  @ApiBearerAuth()
  async getPreference(@CurrentUser() currentUser: UserEntity): Promise<GetSitePreferenceResponseDto> {
    if (!currentUser?.isAdmin)
      return {
        error: GetSitePreferenceResponseError.PERMISSION_DENIED
      };

    return {
      preference: await this.siteSettingService.getPreference()
    };
  }

  @Post("preference")
  @ApiBearerAuth()
  async updatePreference(
    @CurrentUser() currentUser: UserEntity,
    @Body() request: UpdateSitePreferenceRequestDto
  ): Promise<UpdateSitePreferenceResponseDto> {
    if (!currentUser?.isAdmin)
      return {
        error: UpdateSitePreferenceResponseError.PERMISSION_DENIED
      };

    return {
      preference: await this.siteSettingService.updatePreferencePatch(request.preference || {}, currentUser)
    };
  }
}
