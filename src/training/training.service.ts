import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";

import { InjectRepository } from "@nestjs/typeorm";

import { Repository } from "typeorm";

import { CreateTrainingDto } from "./dto/create-training.dto";
import { QueryTrainingSetResponseDto } from "./dto/query-training-set-response.dto";
import { TrainingMetaDto } from "./dto/training-meta.dto";
import { UpdateTrainingDto } from "./dto/update-training.dto";
import { TrainingEntity } from "./entities/training.entity";
import { toChapterMetaDto, toTrainingMetaDto } from "./training.mapper";
import { TrainingProgressService } from "./training-progress.service";
import { UserEntity } from "@/user/user.entity";

interface ReorderItem {
  id: number;
  sortOrder: number;
}

@Injectable()
export class TrainingService {
  constructor(
    @InjectRepository(TrainingEntity)
    private readonly trainingRepository: Repository<TrainingEntity>,
    private readonly trainingProgressService: TrainingProgressService
  ) {}

  async queryTrainingSet(currentUser: UserEntity): Promise<QueryTrainingSetResponseDto> {
    const trainings = await this.trainingRepository.find({ order: { sortOrder: "ASC" } });
    const progress = await this.trainingProgressService.getTrainingProgressByIds(
      currentUser,
      trainings.map(training => training.id)
    );
    return {
      result: trainings.map(training => ({
        ...toTrainingMetaDto(training),
        ...progress.get(training.id)
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

  async getTrainingById(id: number, currentUser: UserEntity): Promise<TrainingMetaDto> {
    const training = await this.trainingRepository.findOneBy({ id });
    if (!training) throw new NotFoundException(`training ${id} not found`);

    const chapters = await training.chapters;
    chapters.sort((a, b) => a.sortOrder - b.sortOrder);
    const [trainingProgress, chapterProgress] = await Promise.all([
      this.trainingProgressService.getTrainingProgressByIds(currentUser, [training.id]),
      this.trainingProgressService.getChapterProgressByIds(
        currentUser,
        chapters.map(chapter => chapter.id)
      )
    ]);

    return {
      ...toTrainingMetaDto(training),
      ...trainingProgress.get(training.id),
      chapters: chapters.map(chapter => ({ ...toChapterMetaDto(chapter), ...chapterProgress.get(chapter.id) }))
    };
  }

  async delTrainingById(id: number): Promise<void> {
    const result = await this.trainingRepository.delete(id);
    if (result.affected === 0) {
      throw new NotFoundException(`training ${id} not found`);
    }
  }

  async reorderTrainings(items: ReorderItem[]): Promise<void> {
    this.validateReorderItems(items);
    const existingTrainings = await this.trainingRepository.findByIds(items.map(item => item.id));
    if (existingTrainings.length !== items.length) {
      throw new NotFoundException("some trainings not found");
    }

    await this.trainingRepository.manager.transaction(async manager => {
      await Promise.all(
        items.map(item => manager.update(TrainingEntity, { id: item.id }, { sortOrder: item.sortOrder }))
      );
    });
  }

  private validateReorderItems(items: ReorderItem[]): void {
    const ids = items.map(item => item.id);
    const sortOrders = items.map(item => item.sortOrder);
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException("duplicate id");
    }
    if (new Set(sortOrders).size !== sortOrders.length) {
      throw new BadRequestException("duplicate sortOrder");
    }
  }
}
