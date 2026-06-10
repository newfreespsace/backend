import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";

import { Repository } from "typeorm";

import { CreateChapterDto } from "./dto/create-chapter.dto";
import { ChapterMetaDto } from "./dto/training-meta.dto";
import { UpdateChapterDto } from "./dto/update-chapter.dto";
import { ChapterEntity } from "./entities/chapter.entity";
import { TrainingEntity } from "./entities/training.entity";
import { toChapterMetaDto, toSectionMetaDto } from "./training.mapper";
import { TrainingProgressService } from "./training-progress.service";
import { UserEntity } from "@/user/user.entity";

@Injectable()
export class ChapterService {
  constructor(
    @InjectRepository(ChapterEntity)
    private readonly chapterRepository: Repository<ChapterEntity>,

    @InjectRepository(TrainingEntity)
    private readonly trainingRepository: Repository<TrainingEntity>,
    private readonly trainingProgressService: TrainingProgressService
  ) {}

  async queryChapterSetByTrainingId(trainingId: number, currentUser: UserEntity): Promise<ChapterMetaDto[]> {
    const chapters = await this.chapterRepository.find({ where: { trainingId }, order: { sortOrder: "ASC" } });
    const progress = await this.trainingProgressService.getChapterProgressByIds(
      currentUser,
      chapters.map(chapter => chapter.id)
    );
    return chapters.map(chapter => ({ ...toChapterMetaDto(chapter), ...progress.get(chapter.id) }));
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

  async getChapterById(id: number, currentUser: UserEntity): Promise<ChapterMetaDto> {
    const chapter = await this.chapterRepository.findOneBy({ id });
    if (!chapter) throw new NotFoundException(`chapter ${id} not found`);
    const sections = await chapter.sections;
    sections.sort((a, b) => a.sortOrder - b.sortOrder);
    const [chapterProgress, sectionProgress] = await Promise.all([
      this.trainingProgressService.getChapterProgressByIds(currentUser, [chapter.id]),
      this.trainingProgressService.getSectionProgressByIds(
        currentUser,
        sections.map(section => section.id)
      )
    ]);
    return {
      ...toChapterMetaDto(chapter),
      ...chapterProgress.get(chapter.id),
      sections: sections.map(section => ({ ...toSectionMetaDto(section), ...sectionProgress.get(section.id) }))
    };
  }
}
