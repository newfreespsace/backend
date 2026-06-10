import { Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";

import { Repository } from "typeorm";

import { ProblemPermissionType, ProblemService } from "@/problem/problem.service";
import { ProblemEntity } from "@/problem/problem.entity";
import { SubmissionService } from "@/submission/submission.service";
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
    private readonly sectionProblemRepository: Repository<SectionProblemEntity>,
    private readonly problemService: ProblemService,
    private readonly submissionService: SubmissionService
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
      .addSelect("sectionProblem.problemId", "problemId");

    if (scope === "section") queryBuilder.where("sectionProblem.sectionId IN (:...ids)", { ids: uniqueIds });
    else if (scope === "chapter") queryBuilder.where("section.chapterId IN (:...ids)", { ids: uniqueIds });
    else queryBuilder.where("chapter.trainingId IN (:...ids)", { ids: uniqueIds });

    const rows: { id: string; problemId: string }[] = await queryBuilder.getRawMany();
    const problemsById = await this.getVisibleProblemsById(
      user,
      rows.map(row => Number(row.problemId))
    );
    const acceptedSubmissions =
      user && problemsById.size > 0
        ? await this.submissionService.getUserLatestSubmissionByProblems(user, Array.from(problemsById.values()), true)
        : new Map();

    for (const row of rows) {
      const id = Number(row.id);
      const problemId = Number(row.problemId);
      if (!problemsById.has(problemId)) continue;

      const progress = result.get(id);
      progress.problemCount++;
      if (acceptedSubmissions.has(problemId)) progress.acceptedProblemCount++;
    }

    return result;
  }

  private async getVisibleProblemsById(user: UserEntity, problemIds: number[]): Promise<Map<number, ProblemEntity>> {
    const uniqueProblemIds = Array.from(new Set(problemIds));
    const problems = await this.problemService.findProblemsByExistingIds(uniqueProblemIds);
    const visibleProblems = await Promise.all(
      problems.map(async problem => {
        if (!problem) return null;
        return (await this.problemService.userHasPermission(user, problem, ProblemPermissionType.View))
          ? problem
          : null;
      })
    );

    return new Map(visibleProblems.filter(problem => problem).map(problem => [problem.id, problem]));
  }
}
