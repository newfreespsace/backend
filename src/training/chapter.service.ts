import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";

import { Repository } from "typeorm";

import { CreateChapterDto } from "./dto/create-chapter.dto";
import { ChapterMetaDto } from "./dto/training-meta.dto";
import { UpdateChapterDto } from "./dto/update-chapter.dto";
import { ChapterEntity } from "./entities/chapter.entity";
import { TrainingEntity } from "./entities/training.entity";
import { toChapterMetaDto, toSectionMetaDto } from "./training.mapper";

@Injectable()
export class ChapterService {
  constructor(
    @InjectRepository(ChapterEntity)
    private readonly chapterRepository: Repository<ChapterEntity>,

    @InjectRepository(TrainingEntity)
    private readonly trainingRepository: Repository<TrainingEntity>
  ) {}

  async queryChapterSetByTrainingId(trainingId: number): Promise<ChapterMetaDto[]> {
    const chapters = await this.chapterRepository.find({ where: { trainingId }, order: { sortOrder: "ASC" } });
    return chapters.map(chapter => ({ ...toChapterMetaDto(chapter) }));
  }

  async createChapter(createChapterDto: CreateChapterDto): Promise<ChapterMetaDto> {
    const { trainingId } = createChapterDto;
    const training = await this.trainingRepository.findOneBy({ id: trainingId });
    if (!training) throw new NotFoundException(`training ${trainingId} not found`);

    const chapter = this.chapterRepository.create(createChapterDto);
    const savedChapter = await this.chapterRepository.save(chapter);
    return { ...toChapterMetaDto(savedChapter) };
  }

  async updateChapter(id: number, updateTrainingDto: UpdateChapterDto): Promise<ChapterMetaDto> {
    const { trainingId } = updateTrainingDto;
    if (trainingId !== undefined) {
      const training = await this.trainingRepository.findOneBy({ id: trainingId });
      if (!training) throw new NotFoundException(`training ${trainingId} not found`);
    }

    const chapter = await this.chapterRepository.preload({
      id,
      ...updateTrainingDto
    });
    if (!chapter) throw new NotFoundException(`chapter ${id} not found`);

    const updatedChapter = await this.chapterRepository.save(chapter);
    return { ...toChapterMetaDto(updatedChapter) };
  }

  async getChapterById(id: number): Promise<ChapterMetaDto> {
    const chapter = await this.chapterRepository.findOneBy({ id });
    if (!chapter) throw new NotFoundException(`chapter ${id} not found`);
    const sections = await chapter.sections;
    sections.sort((a, b) => a.sortOrder - b.sortOrder);
    return {
      ...toChapterMetaDto(chapter),
      sections: sections.map(section => toSectionMetaDto(section))
    };
  }
}
