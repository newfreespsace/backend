import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";

import { Repository } from "typeorm";

import { UserEntity } from "@/user/user.entity";

import { CreateChapterDto } from "./dto/create-chapter.dto";
import { ChapterMetaDto } from "./dto/training-meta.dto";
import { UpdateChapterDto } from "./dto/update-chapter.dto";
import { ChapterEntity } from "./entities/chapter.entity";
import { TrainingEntity } from "./entities/training.entity";
import { toChapterMetaDto, toSectionMetaDto } from "./training.mapper";
import { TrainingProgressService } from "./training-progress.service";

interface ReorderItem {
  id: number;
  sortOrder: number;
}

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

  async updateChapter(id: number, updateChapterDto: UpdateChapterDto): Promise<ChapterMetaDto> {
    return await this.chapterRepository.manager.transaction(async manager => {
      const chapterRepository = manager.getRepository(ChapterEntity);
      const trainingRepository = manager.getRepository(TrainingEntity);
      const existingChapter = await chapterRepository.findOneBy({ id });
      if (!existingChapter) throw new NotFoundException(`chapter ${id} not found`);

      const targetTrainingId = updateChapterDto.trainingId ?? existingChapter.trainingId;
      if (updateChapterDto.trainingId !== undefined) {
        const training = await trainingRepository.findOneBy({ id: targetTrainingId });
        if (!training) throw new NotFoundException(`training ${targetTrainingId} not found`);
      }

      const trainingChanged = targetTrainingId !== existingChapter.trainingId;
      let targetSortOrder = existingChapter.sortOrder;
      if (trainingChanged) {
        const targetChapters = await chapterRepository.find({
          where: { trainingId: targetTrainingId },
          order: { sortOrder: "ASC", id: "ASC" }
        });
        await Promise.all(
          targetChapters.map((targetChapter, index) => {
            const sortOrder = index + 1;
            if (targetChapter.sortOrder === sortOrder) return Promise.resolve();
            return chapterRepository.update(targetChapter.id, { sortOrder });
          })
        );
        targetSortOrder = targetChapters.length + 1;
      }

      const chapter = await chapterRepository.preload({
        id,
        ...updateChapterDto,
        ...(trainingChanged ? { sortOrder: targetSortOrder } : {})
      });
      if (!chapter) throw new NotFoundException(`chapter ${id} not found`);

      const updatedChapter = await chapterRepository.save(chapter);
      if (trainingChanged) {
        const remainingChapters = await chapterRepository.find({
          where: { trainingId: existingChapter.trainingId },
          order: { sortOrder: "ASC", id: "ASC" }
        });
        await Promise.all(
          remainingChapters.map((remainingChapter, index) => {
            const sortOrder = index + 1;
            if (remainingChapter.sortOrder === sortOrder) return Promise.resolve();
            return chapterRepository.update(remainingChapter.id, { sortOrder });
          })
        );
      }

      return { ...toChapterMetaDto(updatedChapter) };
    });
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

  async delChapterById(id: number): Promise<void> {
    await this.chapterRepository.manager.transaction(async manager => {
      const chapterRepository = manager.getRepository(ChapterEntity);
      const chapter = await chapterRepository.findOneBy({ id });
      if (!chapter) throw new NotFoundException(`chapter ${id} not found`);

      await chapterRepository.delete(id);

      const remainingChapters = await chapterRepository.find({
        where: { trainingId: chapter.trainingId },
        order: { sortOrder: "ASC", id: "ASC" }
      });
      await Promise.all(
        remainingChapters.map((remainingChapter, index) => {
          const sortOrder = index + 1;
          if (remainingChapter.sortOrder === sortOrder) return Promise.resolve();
          return chapterRepository.update(remainingChapter.id, { sortOrder });
        })
      );
    });
  }

  async reorderChapters(trainingId: number, items: ReorderItem[]): Promise<void> {
    this.validateReorderItems(items);
    const training = await this.trainingRepository.findOneBy({ id: trainingId });
    if (!training) throw new NotFoundException(`training ${trainingId} not found`);

    const chapters = items.length ? await this.chapterRepository.findByIds(items.map(item => item.id)) : [];
    if (chapters.length !== items.length || chapters.some(chapter => chapter.trainingId !== trainingId)) {
      throw new NotFoundException("some chapters not found");
    }

    await this.chapterRepository.manager.transaction(async manager => {
      await Promise.all(
        items.map(item => manager.update(ChapterEntity, { id: item.id }, { sortOrder: item.sortOrder }))
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
