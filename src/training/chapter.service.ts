import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";

import { Repository } from "typeorm";

import { CreateChapterDto } from "./dto/create-chapter.dto";
import { UpdateChapterDto } from "./dto/update-chapter.dto";
import { ChapterEntity } from "./entities/chapter.entity";

@Injectable()
export class ChapterService {
  constructor(
    @InjectRepository(ChapterEntity)
    private readonly chapterRepository: Repository<ChapterEntity>
  ) {}

  queryChapterSetByTrainingId(trainingId: number) {
    const chapters = this.chapterRepository.find({ where: { trainingId } });
    return chapters;
  }

  createChapter(createChapterDto: CreateChapterDto) {
    const chapter = this.chapterRepository.create(createChapterDto);
    return this.chapterRepository.save(chapter);
  }

  async updateChapter(id: number, updateTrainingDto: UpdateChapterDto) {
    const training = await this.chapterRepository.preload({
      id,
      ...updateTrainingDto
    });
    if (!training) throw new NotFoundException(`chapter ${id} not found`);
    return await this.chapterRepository.save(training);
  }
}
