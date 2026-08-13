import { Body, Controller, Get, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "@/common/user.decorator";
import { UserEntity } from "@/user/user.entity";
import { TrainingPointService } from "@/training-points/training-point.service";

import { SiteSettingService } from "./site-setting.service";

import {
  GetTrainingPointRecalculationRequestDto,
  GetTrainingPointRecalculationResponseDto,
  GetTrainingPointRecalculationResponseError,
  StartTrainingPointRecalculationRequestDto,
  StartTrainingPointRecalculationResponseDto,
  StartTrainingPointRecalculationResponseError
} from "@/training-points/dto";

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
  constructor(
    private readonly siteSettingService: SiteSettingService,
    private readonly trainingPointService: TrainingPointService
  ) {}

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

  @Post("training-points/recalculate")
  @ApiBearerAuth()
  async startTrainingPointRecalculation(
    @CurrentUser() currentUser: UserEntity,
    @Body() request: StartTrainingPointRecalculationRequestDto
  ): Promise<StartTrainingPointRecalculationResponseDto> {
    if (!currentUser?.isAdmin)
      return {
        error: StartTrainingPointRecalculationResponseError.PermissionDenied
      };

    const task = await this.trainingPointService.startRecalculation(currentUser.id, request.dryRun);
    if (!task) {
      const activeTask = await this.trainingPointService.getActiveRecalculationTask();
      return {
        error: StartTrainingPointRecalculationResponseError.AlreadyRunning,
        task: activeTask ? this.trainingPointService.toTaskDto(activeTask) : undefined
      };
    }

    return {
      task: this.trainingPointService.toTaskDto(task)
    };
  }

  @Post("training-points/recalculation-status")
  @ApiBearerAuth()
  async getTrainingPointRecalculation(
    @CurrentUser() currentUser: UserEntity,
    @Body() request: GetTrainingPointRecalculationRequestDto
  ): Promise<GetTrainingPointRecalculationResponseDto> {
    if (!currentUser?.isAdmin)
      return {
        error: GetTrainingPointRecalculationResponseError.PermissionDenied
      };

    const task = await this.trainingPointService.getRecalculationTask(request.taskId);
    if (!task)
      return {
        error: GetTrainingPointRecalculationResponseError.NotFound
      };

    return {
      task: this.trainingPointService.toTaskDto(task)
    };
  }
}
