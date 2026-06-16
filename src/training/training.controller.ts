import { Body, Controller, ForbiddenException, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "@/common/user.decorator";
import { UserEntity } from "@/user/user.entity";
import { UserPrivilegeService, UserPrivilegeType } from "@/user/user-privilege.service";

import { CreateTrainingDto } from "./dto/create-training.dto";
import { DeleteByIdRequestDto } from "./dto/delete-by-id-request.dto";
import { GetTrainingRequestDto } from "./dto/get-training-request.dto";
import { QueryTrainingSetResponseDto } from "./dto/query-training-set-response.dto";
import { ReorderTrainingsDto } from "./dto/reorder-items.dto";
import { TrainingMetaDto } from "./dto/training-meta.dto";
import { UpdateTrainingDto } from "./dto/update-training.dto";
import { TrainingService } from "./training.service";
import { SetCurrentTrainingDto } from "./dto/set-current-training.dto";
import { SetCurrentTrainingResponseDto } from "./dto/set-current-training-response.dto";

@ApiTags("Training")
@Controller("training")
export class TrainingController {
  constructor(
    private readonly trainingService: TrainingService,
    private readonly userPrivilegeService: UserPrivilegeService
  ) {}

  private async checkManageTrainingPermission(currentUser: UserEntity): Promise<void> {
    if (!(await this.userPrivilegeService.userHasPrivilege(currentUser, UserPrivilegeType.ManageProblem))) {
      throw new ForbiddenException("permission denied");
    }
  }

  @Post("queryTrainingSet")
  @ApiOperation({ summary: "Query Trainings in Training set" })
  async queryTrainingSet(
    @CurrentUser()
    currentUser: UserEntity
  ): Promise<QueryTrainingSetResponseDto> {
    return await this.trainingService.queryTrainingSet(currentUser);
  }

  @Post("createTraining")
  @ApiBearerAuth()
  async createTraining(
    @CurrentUser()
    currentUser: UserEntity,
    @Body()
    request: CreateTrainingDto
  ): Promise<TrainingMetaDto> {
    await this.checkManageTrainingPermission(currentUser);
    const training = await this.trainingService.createTraining(request);
    return training;
  }

  @Post("getTrainingById")
  getTrainingById(
    @CurrentUser()
    currentUser: UserEntity,
    @Body()
    request: GetTrainingRequestDto
  ): Promise<TrainingMetaDto> {
    const { id } = request;
    const training = this.trainingService.getTrainingById(id, currentUser);
    return training;
  }

  @Post("updateTraining")
  @ApiBearerAuth()
  async updateTraining(
    @CurrentUser()
    currentUser: UserEntity,
    @Body()
    request: UpdateTrainingDto
  ): Promise<TrainingMetaDto> {
    await this.checkManageTrainingPermission(currentUser);
    const { id } = request;
    const training = await this.trainingService.updateTraining(id, request);
    return training;
  }

  @Post("delTrainingById")
  @ApiBearerAuth()
  async delTrainingById(
    @CurrentUser()
    currentUser: UserEntity,
    @Body()
    request: DeleteByIdRequestDto
  ): Promise<void> {
    await this.checkManageTrainingPermission(currentUser);
    await this.trainingService.delTrainingById(request.id);
  }

  @Post("reorderTrainings")
  @ApiBearerAuth()
  async reorderTrainings(
    @CurrentUser()
    currentUser: UserEntity,
    @Body()
    request: ReorderTrainingsDto
  ): Promise<void> {
    await this.checkManageTrainingPermission(currentUser);
    await this.trainingService.reorderTrainings(request.items);
  }

  @Post("setCurrentTraining")
  @ApiBearerAuth()
  async setCurrentTraining(
    @CurrentUser()
    currentUser: UserEntity,
    @Body()
    request: SetCurrentTrainingDto
  ): Promise<SetCurrentTrainingResponseDto> {
    if (!currentUser) throw new ForbiddenException("permission denied");
    return await this.trainingService.setCurrentTraining(currentUser, request.trainingId);
  }
}
