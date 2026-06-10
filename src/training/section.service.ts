import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";

import { Repository } from "typeorm";

import { ProblemService, ProblemPermissionType } from "@/problem/problem.service";
import { UserEntity } from "@/user/user.entity";
import { SubmissionService } from "@/submission/submission.service";

import { CreateSectionDto } from "./dto/create-section.dto";
import { UpdateSectionDto } from "./dto/update-section.dto";
import { SectionEntity } from "./entities/section.entity";
import { SectionProblemEntity } from "./entities/section_problem.entity";
import { GetSectionByIdDto } from "./dto/get-section-by-id.dto";
import { SectionMetaDto } from "./dto/training-meta.dto";
import { toSectionMetaDto } from "./training.mapper";
import { GetSectionByIdResponseDto } from "./dto/get-section-by-id-response.dto";
import { SetSectionProblemsDto } from "./dto/set-section-problems.dto";
import { SetSectionProblemsResponseDto } from "./dto/set-section-problems-response.dto";
import { ChapterEntity } from "./entities/chapter.entity";
import { TrainingProgressService } from "./training-progress.service";

@Injectable()
export class SectionService {
  constructor(
    @InjectRepository(ChapterEntity)
    private readonly chapterRepository: Repository<ChapterEntity>,
    @InjectRepository(SectionEntity)
    private readonly sectionRepository: Repository<SectionEntity>,
    @InjectRepository(SectionProblemEntity)
    private readonly sectionProblemRepository: Repository<SectionProblemEntity>,

    private readonly problemService: ProblemService,
    private readonly submissionService: SubmissionService,
    private readonly trainingProgressService: TrainingProgressService
  ) {}

  async querySectionSetByChapterId(chapterId: number, currentUser: UserEntity): Promise<SectionMetaDto[]> {
    const sections = await this.sectionRepository.find({ where: { chapterId }, order: { sortOrder: "ASC" } });
    const progress = await this.trainingProgressService.getSectionProgressByIds(
      currentUser,
      sections.map(section => section.id)
    );
    return sections.map(section => ({ ...toSectionMetaDto(section), ...progress.get(section.id) }));
  }

  async createSection(createSectionDto: CreateSectionDto): Promise<SectionMetaDto> {
    const { chapterId } = createSectionDto;
    const chapter = await this.chapterRepository.findOneBy({ id: chapterId });
    if (!chapter) throw new NotFoundException(`chapter ${chapterId} not found`);
    const section = this.sectionRepository.create(createSectionDto);
    const savedSection = await this.sectionRepository.save(section);
    return { ...toSectionMetaDto(savedSection) };
  }

  async updateSection(id: number, updateSectionDto: UpdateSectionDto): Promise<SectionMetaDto> {
    const { chapterId } = updateSectionDto;
    if (chapterId !== undefined) {
      const chapter = await this.chapterRepository.findOneBy({ id: chapterId });
      if (!chapter) throw new NotFoundException(`chaper ${chapterId} not found`);
    }

    const section = await this.sectionRepository.preload({
      id,
      ...updateSectionDto
    });
    if (!section) throw new NotFoundException(`section ${id} not found`);
    const updateSection = await this.sectionRepository.save(section);
    return { ...toSectionMetaDto(updateSection) };
  }

  // async addProblemToSection(addProblemFileRequestDto: AddProblemToSectionDto): Promise<AddProblemToSectionResponseDto> {
  //   const { sectionId, problemId, sortOrder } = addProblemFileRequestDto;

  //   const section = await this.sectionRepository.findOneBy({ id: sectionId });
  //   if (!section) throw new NotFoundException(`section ${sectionId} not found`);

  //   const problem = await this.problemService.findProblemById(problemId);
  //   if (!problem) throw new NotFoundException(`problem ${problemId} not found`);

  //   const sectionProblem = this.sectionProblemRepository.create({ sectionId, problemId, sortOrder });

  //   const savedSectionProblem = await this.sectionProblemRepository.save(sectionProblem);

  //   return {
  //     id: savedSectionProblem.id,
  //     sectionId: savedSectionProblem.sectionId,
  //     problemId: savedSectionProblem.problemId,
  //     sortOrder: savedSectionProblem.sortOrder
  //   };
  // }

  async getSectionById(currentUser: UserEntity, request: GetSectionByIdDto): Promise<GetSectionByIdResponseDto> {
    const { id, locale, titleOnly } = request;

    const section = await this.sectionRepository.findOneBy({ id });
    if (!section) throw new NotFoundException(`section ${id} not found`);
    const progress = await this.trainingProgressService.getSectionProgressByIds(currentUser, [section.id]);

    const sectionProblems = await section.problems;
    sectionProblems.sort((a, b) => a.sortOrder - b.sortOrder);

    const problems = await Promise.all(sectionProblems.map(sectionProblem => sectionProblem.problem));

    const visibleProblemFlags = await Promise.all(
      problems.map(problem => this.problemService.userHasPermission(currentUser, problem, ProblemPermissionType.View))
    );

    const visibleProblems = problems.filter((_, index) => visibleProblemFlags[index]);

    const [acceptedSubmissions, nonAcceptedSubmissions] =
      !titleOnly && currentUser
        ? await Promise.all([
            this.submissionService.getUserLatestSubmissionByProblems(currentUser, visibleProblems, true),
            this.submissionService.getUserLatestSubmissionByProblems(currentUser, visibleProblems)
          ])
        : [new Map(), new Map()];

    const result = await Promise.all(
      visibleProblems.map(async problem => {
        const titleLocale = problem.locales.includes(locale) ? locale : problem.locales[0];

        const title = await this.problemService.getProblemLocalizedTitle(problem, titleLocale);
        const problemTags = !titleOnly && (await this.problemService.getProblemTagsByProblem(problem));
        const submission = acceptedSubmissions.get(problem.id) || nonAcceptedSubmissions.get(problem.id);

        return {
          meta: await this.problemService.getProblemMeta(problem, true),
          title,
          tags:
            !titleOnly &&
            (await Promise.all(
              problemTags.map(problemTag => this.problemService.getProblemTagLocalized(problemTag, locale))
            )),
          resultLocale: titleLocale,
          submission: submission && (await this.submissionService.getSubmissionBasicMeta(submission))
        };
      })
    );
    return {
      ...toSectionMetaDto(section),
      ...progress.get(section.id),
      problems: result
    };
  }

  async setSectionProblems(request: SetSectionProblemsDto): Promise<SetSectionProblemsResponseDto> {
    const { sectionId, problems } = request;
    const section = await this.sectionRepository.findOneBy({ id: sectionId });
    if (!section) throw new NotFoundException(`section ${sectionId} not found`);

    const problemIds = problems.map(problem => problem.problemId);
    const sortOrders = problems.map(problem => problem.sortOrder);

    if (new Set(problemIds).size !== problemIds.length) {
      throw new BadRequestException("duplicate problemId");
    }
    if (new Set(sortOrders).size !== sortOrders.length) {
      throw new BadRequestException("duplicate sortOrder");
    }

    const foundProblems = await this.problemService.findProblemsByExistingIds(problemIds);

    if (foundProblems.some(problem => !problem)) {
      throw new NotFoundException("some problems not found");
    }

    await this.sectionProblemRepository.manager.transaction(async manager => {
      await manager.delete(SectionProblemEntity, { sectionId });

      const sectionProblems = problems.map(problem =>
        manager.create(SectionProblemEntity, {
          sectionId,
          problemId: problem.problemId,
          sortOrder: problem.sortOrder
        })
      );

      await manager.save(SectionProblemEntity, sectionProblems);
    });

    return { success: true };
  }
}
