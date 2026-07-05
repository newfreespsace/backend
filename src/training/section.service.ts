import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";

import { Repository } from "typeorm";

import { GroupService } from "@/group/group.service";
import { ProblemService, ProblemPermissionType } from "@/problem/problem.service";
import { UserEntity } from "@/user/user.entity";
import { UserService } from "@/user/user.service";
import { UserPrivilegeService, UserPrivilegeType } from "@/user/user-privilege.service";
import { SubmissionService } from "@/submission/submission.service";
import { SubmissionEntity } from "@/submission/submission.entity";
import { SubmissionStatus } from "@/submission/submission-status.enum";

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
import {
  QuerySectionGroupRanklistDto,
  QuerySectionGroupRanklistResponseDto
} from "./dto/query-section-group-ranklist.dto";
import {
  QuerySectionsByProblemIdDto,
  QuerySectionsByProblemIdResponseDto
} from "./dto/query-sections-by-problem-id.dto";
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
    @InjectRepository(SubmissionEntity)
    private readonly submissionRepository: Repository<SubmissionEntity>,

    private readonly problemService: ProblemService,
    private readonly submissionService: SubmissionService,
    private readonly trainingProgressService: TrainingProgressService,
    private readonly groupService: GroupService,
    private readonly userService: UserService,
    private readonly userPrivilegeService: UserPrivilegeService
  ) {}

  async querySectionSetByChapterId(chapterId: number, currentUser: UserEntity): Promise<SectionMetaDto[]> {
    const sections = await this.sectionRepository.find({ where: { chapterId }, order: { sortOrder: "ASC" } });
    const progress = await this.trainingProgressService.getSectionProgressByIds(
      currentUser,
      sections.map(section => section.id)
    );
    return sections.map(section => ({ ...toSectionMetaDto(section), ...progress.get(section.id) }));
  }

  async querySectionsByProblemId(
    currentUser: UserEntity,
    request: QuerySectionsByProblemIdDto
  ): Promise<QuerySectionsByProblemIdResponseDto> {
    const problem = await this.problemService.findProblemById(request.problemId);
    if (!problem) throw new NotFoundException(`problem ${request.problemId} not found`);
    if (!(await this.problemService.userHasPermission(currentUser, problem, ProblemPermissionType.View))) {
      throw new ForbiddenException("permission denied");
    }

    const rows: {
      trainingId: string;
      trainingTitle: string;
      chapterId: string;
      chapterTitle: string;
      sectionId: string;
      sectionTitle: string;
      sortOrder: string;
    }[] = await this.sectionProblemRepository
      .createQueryBuilder("sectionProblem")
      .innerJoin("sectionProblem.section", "section")
      .innerJoin("section.chapter", "chapter")
      .innerJoin("chapter.training", "training")
      .where("sectionProblem.problemId = :problemId", { problemId: request.problemId })
      .select("training.id", "trainingId")
      .addSelect("training.title", "trainingTitle")
      .addSelect("chapter.id", "chapterId")
      .addSelect("chapter.title", "chapterTitle")
      .addSelect("section.id", "sectionId")
      .addSelect("section.title", "sectionTitle")
      .addSelect("sectionProblem.sortOrder", "sortOrder")
      .orderBy("training.sortOrder", "ASC")
      .addOrderBy("chapter.sortOrder", "ASC")
      .addOrderBy("section.sortOrder", "ASC")
      .addOrderBy("sectionProblem.sortOrder", "ASC")
      .getRawMany();

    return {
      references: rows.map(row => ({
        trainingId: Number(row.trainingId),
        trainingTitle: row.trainingTitle,
        chapterId: Number(row.chapterId),
        chapterTitle: row.chapterTitle,
        sectionId: Number(row.sectionId),
        sectionTitle: row.sectionTitle,
        sortOrder: Number(row.sortOrder)
      }))
    };
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

    const sectionProblems = await section.problems;
    sectionProblems.sort((a, b) => a.sortOrder - b.sortOrder);

    const problems = await Promise.all(sectionProblems.map(sectionProblem => sectionProblem.problem));

    const visibleProblemFlags = await Promise.all(
      problems.map(problem => this.problemService.userHasPermission(currentUser, problem, ProblemPermissionType.View))
    );

    const visibleProblems = problems.filter((_, index) => visibleProblemFlags[index]);

    const [acceptedSubmissions, nonAcceptedSubmissions] = currentUser
      ? await Promise.all([
          this.submissionService.getUserLatestSubmissionByProblems(currentUser, visibleProblems, true),
          !titleOnly
            ? this.submissionService.getUserLatestSubmissionByProblems(currentUser, visibleProblems)
            : new Map()
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
      problemCount: visibleProblems.length,
      acceptedProblemCount: visibleProblems.filter(problem => acceptedSubmissions.has(problem.id)).length,
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

  async delSectionById(id: number): Promise<void> {
    const result = await this.sectionRepository.delete(id);
    if (result.affected === 0) {
      throw new NotFoundException(`section ${id} not found`);
    }
  }

  async reorderSections(chapterId: number, items: { id: number; sortOrder: number }[]): Promise<void> {
    const ids = items.map(item => item.id);
    const sortOrders = items.map(item => item.sortOrder);
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException("duplicate id");
    }
    if (new Set(sortOrders).size !== sortOrders.length) {
      throw new BadRequestException("duplicate sortOrder");
    }

    const chapter = await this.chapterRepository.findOneBy({ id: chapterId });
    if (!chapter) throw new NotFoundException(`chapter ${chapterId} not found`);

    const sections = items.length ? await this.sectionRepository.findByIds(ids) : [];
    if (sections.length !== items.length || sections.some(section => section.chapterId !== chapterId)) {
      throw new NotFoundException("some sections not found");
    }

    await this.sectionRepository.manager.transaction(async manager => {
      await Promise.all(
        items.map(item => manager.update(SectionEntity, { id: item.id }, { sortOrder: item.sortOrder }))
      );
    });
  }

  async querySectionGroupRanklist(
    currentUser: UserEntity,
    request: QuerySectionGroupRanklistDto
  ): Promise<QuerySectionGroupRanklistResponseDto> {
    const { sectionId, groupId } = request;

    const section = await this.sectionRepository.findOneBy({ id: sectionId });
    if (!section) throw new NotFoundException(`section ${sectionId} not found`);

    if (!currentUser) throw new ForbiddenException("permission denied");

    const canManageTraining = await this.userPrivilegeService.userHasPrivilege(
      currentUser,
      UserPrivilegeType.ManageProblem
    );
    if (groupId && !canManageTraining) throw new ForbiddenException("permission denied");

    const groups = groupId
      ? [await this.groupService.findGroupById(groupId)]
      : (await this.groupService.getUserJoinedGroups(currentUser))[0];
    if (groupId && !groups[0]) throw new NotFoundException(`group ${groupId} not found`);

    const sectionProblems = await section.problems;
    const problemIds = sectionProblems.map(sectionProblem => sectionProblem.problemId);
    const membershipsList = await Promise.all(groups.map(group => this.groupService.getGroupMemberList(group)));
    const userIds = Array.from(new Set(membershipsList.flat().map(membership => membership.userId)));
    if (!groupId && userIds.length === 0) userIds.push(currentUser.id);

    const acceptedProblemIdsByUserId = new Map<number, Set<number>>();
    if (problemIds.length > 0 && userIds.length > 0) {
      const rows: { userId: string; problemId: string }[] = await this.submissionRepository
        .createQueryBuilder("submission")
        .select("submission.submitterId", "userId")
        .addSelect("submission.problemId", "problemId")
        .where("submission.submitterId IN (:...userIds)", { userIds })
        .andWhere("submission.problemId IN (:...problemIds)", { problemIds })
        .andWhere("submission.status = :status", { status: SubmissionStatus.Accepted })
        .distinct(true)
        .getRawMany();

      rows.forEach(row => {
        const userId = Number(row.userId);
        const problemId = Number(row.problemId);
        if (!acceptedProblemIdsByUserId.has(userId)) acceptedProblemIdsByUserId.set(userId, new Set<number>());
        acceptedProblemIdsByUserId.get(userId).add(problemId);
      });
    }

    const users = await this.userService.findUsersByExistingIds(userIds);
    const items = await Promise.all(
      users.map(async user => {
        const acceptedProblemIds = Array.from(acceptedProblemIdsByUserId.get(user.id) || []);
        return {
          rank: 0,
          user: await this.userService.getUserMeta(user, currentUser),
          acceptedProblemCount: acceptedProblemIds.length,
          acceptedProblemIds
        };
      })
    );

    items.sort(
      (a, b) =>
        b.acceptedProblemCount - a.acceptedProblemCount ||
        a.user.username.localeCompare(b.user.username) ||
        a.user.id - b.user.id
    );

    let previousAcceptedProblemCount: number = null;
    let previousRank = 0;
    items.forEach((item, index) => {
      if (item.acceptedProblemCount === previousAcceptedProblemCount) item.rank = previousRank;
      else {
        item.rank = index + 1;
        previousRank = item.rank;
        previousAcceptedProblemCount = item.acceptedProblemCount;
      }
    });

    return {
      sectionId,
      groupId,
      groups: await Promise.all(groups.map(group => this.groupService.getGroupMeta(group))),
      memberCount: userIds.length,
      problemCount: problemIds.length,
      result: items
    };
  }
}
