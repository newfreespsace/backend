import { Body, Controller, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";

import { CreateTrainingDto } from "./dto/create-training.dto";
import { UpdateTrainingDto } from "./dto/update-training.dto";
import { TrainingService } from "./training.service";

@ApiTags("training")
@Controller("training")
export class TrainingController {
  constructor(private readonly trainingService: TrainingService) {}

  @Post("queryTrainingSet")
  queryTrainingSet() {
    const trainings = this.trainingService.queryTrainingSet();
    return trainings;
  }

  @Post("createTraining")
  createTraining(
    @Body()
    request: CreateTrainingDto
  ) {
    const training = this.trainingService.createTraining(request);
    return training;
  }

  @Post("getTraining")
  getTraining(
    @Body()
    request: any
  ): string {
    return `this action returns training ${request.id}!`;
  }

  @Post("updateTraining")
  updateTraining(
    @Body()
    request: UpdateTrainingDto
  ) {
    const { id } = request;
    const training = this.trainingService.updateTraining(id, request);
    return training;
  }
}
