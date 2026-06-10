import { Injectable, NotFoundException } from "@nestjs/common";

import { InjectRepository } from "@nestjs/typeorm";

import { Repository } from "typeorm";

import { CreateTrainingDto } from "./dto/create-training.dto";
import { QueryTrainingSetResponseDto } from "./dto/query-training-set-response.dto";
import { TrainingMetaDto } from "./dto/training-meta.dto";
import { UpdateTrainingDto } from "./dto/update-training.dto";
import { TrainingEntity } from "./entities/training.entity";
import { toChapterMetaDto, toTrainingMetaDto } from "./training.mapper";

@Injectable()
export class TrainingService {
  constructor(
    @InjectRepository(TrainingEntity)
    private readonly trainingRepository: Repository<TrainingEntity>
  ) {}

  async queryTrainingSet(): Promise<QueryTrainingSetResponseDto> {
    const trainings = await this.trainingRepository.find({ order: { sortOrder: "ASC" } });
    return {
      result: trainings.map(training => ({
        ...toTrainingMetaDto(training)
      })),
      count: trainings.length
    };
  }

  async createTraining(createTrainingDto: CreateTrainingDto): Promise<TrainingMetaDto> {
    const training = this.trainingRepository.create(createTrainingDto);
    const savedTraining = await this.trainingRepository.save(training);

    return { ...toTrainingMetaDto(savedTraining) };
  }

  async updateTraining(id: number, updateTrainingDto: UpdateTrainingDto): Promise<TrainingMetaDto> {
    // preload() 是 TypeORM 里的一个方法，常用于更新数据前，先根据 id 查出原来的实体，再把新数据合并进去。
    const training = await this.trainingRepository.preload({
      id,
      ...updateTrainingDto
    });
    if (!training) throw new NotFoundException(`training ${id} not found`);
    const updatedTraining = await this.trainingRepository.save(training);
    return { ...toTrainingMetaDto(updatedTraining) };
  }

  async getTrainingById(id: number): Promise<TrainingMetaDto> {
    const training = await this.trainingRepository.findOneBy({ id });
    if (!training) throw new NotFoundException(`training ${id} not found`);

    const chapters = await training.chapters;
    chapters.sort((a, b) => a.sortOrder - b.sortOrder);

    return { ...toTrainingMetaDto(training), chapters: chapters.map(chapter => ({ ...toChapterMetaDto(chapter) })) };
  }

  async delTrainingById(id: number): Promise<void> {
    const result = await this.trainingRepository.delete(id);
    if (result.affected === 0) {
      throw new NotFoundException(`training ${id} not found`);
    }
  }
}
