import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";

import { Repository } from "typeorm";

import { ProblemService } from "@/problem/problem.service";
import { UserEntity } from "@/user/user.entity";

import { CreateSectionDto } from "./dto/create-section.dto";
import { UpdateSectionDto } from "./dto/update-section.dto";
import { SectionEntity } from "./entities/section.entity";
import { SectionProblemEntity } from "./entities/section_problem.entity";
import { AddProblemToSectionDto } from "./dto/add-problem-to-section.dto";
import { GetSectionByIdDto } from "./dto/get-section-by-id.dto";

@Injectable()
export class SectionService {
  constructor(
    @InjectRepository(SectionEntity)
    private readonly sectionRepository: Repository<SectionEntity>,

    @InjectRepository(SectionProblemEntity)
    private readonly sectionProblemRepository: Repository<SectionProblemEntity>,

    private readonly problemService: ProblemService
  ) {}

  querySectionSetByChapterId(chapterId: number) {
    const sections = this.sectionRepository.find({ where: { chapterId } });
    return sections;
  }

  createSection(createSectionDto: CreateSectionDto) {
    const section = this.sectionRepository.create(createSectionDto);
    return this.sectionRepository.save(section);
  }

  async updateSection(id: number, updateTrainingDto: UpdateSectionDto) {
    const training = await this.sectionRepository.preload({
      id,
      ...updateTrainingDto
    });
    if (!training) throw new NotFoundException(`section ${id} not found`);
    return await this.sectionRepository.save(training);
  }

  async addProblemToSection(addProblemFileRequestDto: AddProblemToSectionDto) {
    const { sectionId, problemId, sortOrder } = addProblemFileRequestDto;

    const section = await this.sectionRepository.findOneBy({ id: sectionId });
    if (!section) throw new NotFoundException(`section ${sectionId} not found`);

    const problem = await this.problemService.findProblemById(problemId);
    if (!problem) throw new NotFoundException(`problem ${problemId} not found`);

    const sectionProblem = this.sectionProblemRepository.create({ sectionId, problemId, sortOrder });

    return await this.sectionProblemRepository.save(sectionProblem);
  }

  async getSectionById(currentUser: UserEntity, request: GetSectionByIdDto) {
    const { id, locale, titleOnly } = request;

    const section = await this.sectionRepository.findOneBy({ id });
    if (!section) throw new NotFoundException(`section ${id} not found`);

    const sectionProblems = await section.problems;
    sectionProblems.sort((a, b) => a.sortOrder - b.sortOrder);

    const problems = await Promise.all(sectionProblems.map(sectionProblem => sectionProblem.problem));

    const result = await Promise.all(
      problems.map(async problem => {
        const titleLocale = problem.locales.includes(locale) ? locale : problem.locales[0];

        const title = await this.problemService.getProblemLocalizedTitle(problem, titleLocale);
        const problemTags = !titleOnly && (await this.problemService.getProblemTagsByProblem(problem));

        return {
          meta: await this.problemService.getProblemMeta(problem, true),
          title,
          tags:
            !titleOnly &&
            (await Promise.all(
              problemTags.map(problemTag => this.problemService.getProblemTagLocalized(problemTag, locale))
            )),
          resultLocale: titleLocale
        };
      })
    );
    return {
      ...section,
      problems: result
    };
  }
}
