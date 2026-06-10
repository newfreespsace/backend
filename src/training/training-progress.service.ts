import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";

import { Repository } from "typeorm";

import { SubmissionStatus } from "@/submission/submission-status.enum";
import { UserEntity } from "@/user/user.entity";

import { SectionProblemEntity } from "./entities/section_problem.entity";

export interface TrainingProgress {
  problemCount: number;
  acceptedProblemCount: number;
}

type ProgressScope = "section" | "chapter" | "training";

@Injectable()
export class TrainingProgressService {
  constructor(
    @InjectRepository(SectionProblemEntity)
    private readonly sectionProblemRepository: Repository<SectionProblemEntity>
  ) {}

  async getTrainingProgressByIds(user: UserEntity, trainingIds: number[]): Promise<Map<number, TrainingProgress>> {
    return await this.getProgressByIds(user, "training", trainingIds);
  }

  async getChapterProgressByIds(user: UserEntity, chapterIds: number[]): Promise<Map<number, TrainingProgress>> {
    return await this.getProgressByIds(user, "chapter", chapterIds);
  }

  async getSectionProgressByIds(user: UserEntity, sectionIds: number[]): Promise<Map<number, TrainingProgress>> {
    return await this.getProgressByIds(user, "section", sectionIds);
  }

  private async getProgressByIds(
    user: UserEntity,
    scope: ProgressScope,
    ids: number[]
  ): Promise<Map<number, TrainingProgress>> {
    const uniqueIds = Array.from(new Set(ids));
    const result = new Map(uniqueIds.map(id => [id, { problemCount: 0, acceptedProblemCount: 0 }]));
    if (uniqueIds.length === 0) return result;

    const groupColumn = {
      section: "sectionProblem.sectionId",
      chapter: "section.chapterId",
      training: "chapter.trainingId"
    }[scope];

    const queryBuilder = this.sectionProblemRepository
      .createQueryBuilder("sectionProblem")
      .innerJoin("sectionProblem.section", "section")
      .innerJoin("section.chapter", "chapter")
      .select(groupColumn, "id")
      .addSelect("COUNT(DISTINCT sectionProblem.id)", "problemCount")
      .groupBy(groupColumn);

    if (user) {
      queryBuilder
        .leftJoin(
          "submission",
          "submission",
          [
            "submission.problemId = sectionProblem.problemId",
            "submission.submitterId = :submitterId",
            "submission.status = :status"
          ].join(" AND "),
          { submitterId: user.id, status: SubmissionStatus.Accepted }
        )
        .addSelect(
          "COUNT(DISTINCT CASE WHEN submission.id IS NOT NULL THEN sectionProblem.id ELSE NULL END)",
          "acceptedProblemCount"
        );
    } else {
      queryBuilder.addSelect("0", "acceptedProblemCount");
    }

    if (scope === "section") queryBuilder.where("sectionProblem.sectionId IN (:...ids)", { ids: uniqueIds });
    else if (scope === "chapter") queryBuilder.where("section.chapterId IN (:...ids)", { ids: uniqueIds });
    else queryBuilder.where("chapter.trainingId IN (:...ids)", { ids: uniqueIds });

    const rows: { id: string; problemCount: string; acceptedProblemCount: string }[] = await queryBuilder.getRawMany();
    for (const row of rows) {
      result.set(Number(row.id), {
        problemCount: Number(row.problemCount),
        acceptedProblemCount: Number(row.acceptedProblemCount)
      });
    }

    return result;
  }
}
