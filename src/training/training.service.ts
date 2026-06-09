import { Injectable, NotFoundException } from "@nestjs/common";

import { InjectRepository } from "@nestjs/typeorm";

import { Repository } from "typeorm";

import { CreateTrainingDto } from "./dto/create-training.dto";
import { UpdateTrainingDto } from "./dto/update-training.dto";
import { TrainingEntity } from "./entities/training.entity";

@Injectable()
export class TrainingService {
  constructor(
    @InjectRepository(TrainingEntity)
    private readonly trainingRepository: Repository<TrainingEntity>
  ) {}

  queryTrainingSet() {
    const trainings = this.trainingRepository.find();
    return trainings;
  }

  createTraining(createTrainingDto: CreateTrainingDto) {
    const training = this.trainingRepository.create(createTrainingDto);
    return this.trainingRepository.save(training);
  }

  async updateTraining(id: number, updateTrainingDto: UpdateTrainingDto) {
    // preload() 是 TypeORM 里的一个方法，常用于更新数据前，先根据 id 查出原来的实体，再把新数据合并进去。
    const training = await this.trainingRepository.preload({
      id,
      ...updateTrainingDto
    });
    if (!training) throw new NotFoundException(`training ${id} not found`);
    return await this.trainingRepository.save(training);
  }
}
