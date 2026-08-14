import { ChapterMetaDto, SectionMetaDto, TrainingMetaDto } from "./dto/training-meta.dto";
import { ChapterEntity } from "./entities/chapter.entity";
import { SectionEntity } from "./entities/section.entity";
import { TrainingEntity } from "./entities/training.entity";

export function toTrainingMetaDto(training: TrainingEntity): TrainingMetaDto {
  return {
    id: training.id,
    title: training.title,
    description: training.description,
    sortOrder: training.sortOrder,
    problemCount: 0,
    acceptedProblemCount: 0
  };
}

export function toChapterMetaDto(chapter: ChapterEntity): ChapterMetaDto {
  return {
    id: chapter.id,
    trainingId: chapter.trainingId,
    title: chapter.title,
    description: chapter.description,
    sortOrder: chapter.sortOrder,
    problemCount: 0,
    acceptedProblemCount: 0
  };
}

export function toSectionMetaDto(section: SectionEntity): SectionMetaDto {
  return {
    id: section.id,
    chapterId: section.chapterId,
    title: section.title,
    description: section.description,
    sortOrder: section.sortOrder,
    problemCount: 0,
    acceptedProblemCount: 0
  };
}
