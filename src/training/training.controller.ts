import { Body, Controller, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "@/common/user.decorator";
import { UserEntity } from "@/user/user.entity";

import { CreateTrainingDto } from "./dto/create-training.dto";
import { DeleteChapterByIdRequestDto } from "./dto/delete-chapter-by-id-request.dto";
import { GetTrainingRequestDto } from "./dto/get-training-request.dto";
import { QueryTrainingSetResponseDto } from "./dto/query-training-set-response.dto";
import { TrainingMetaDto } from "./dto/training-meta.dto";
import { UpdateTrainingDto } from "./dto/update-training.dto";
import { TrainingService } from "./training.service";

@ApiTags("Training")
@Controller("training")
export class TrainingController {
  constructor(private readonly trainingService: TrainingService) {}

  @Post("queryTrainingSet")
  @ApiOperation({ summary: "Query Trainings in Training set" })
  async queryTrainingSet(
    @CurrentUser()
    currentUser: UserEntity
  ): Promise<QueryTrainingSetResponseDto> {
    return await this.trainingService.queryTrainingSet(currentUser);
  }

  @Post("createTraining")
  createTraining(
    @Body()
    request: CreateTrainingDto
  ): Promise<TrainingMetaDto> {
    const training = this.trainingService.createTraining(request);
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
  updateTraining(
    @Body()
    request: UpdateTrainingDto
  ): Promise<TrainingMetaDto> {
    const { id } = request;
    const training = this.trainingService.updateTraining(id, request);
    return training;
  }

  @Post("delTrainingById")
  delTrainingById(
    @Body()
    request: DeleteChapterByIdRequestDto
  ) {
    this.trainingService.delTrainingById(request.id);
  }
}
