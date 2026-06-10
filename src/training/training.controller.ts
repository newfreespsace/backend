import { Body, Controller, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";

import { CreateTrainingDto } from "./dto/create-training.dto";
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
  async queryTrainingSet(): Promise<QueryTrainingSetResponseDto> {
    return await this.trainingService.queryTrainingSet();
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
    @Body()
    request: GetTrainingRequestDto
  ): Promise<TrainingMetaDto> {
    const { id } = request;
    const training = this.trainingService.getTrainingById(id);
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
}
