import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";

import { Repository } from "typeorm";

import { UserEntity } from "@/user/user.entity";
import { UserService } from "@/user/user.service";
import { SubmissionStatus } from "@/submission/submission-status.enum";

import { CreateTrainingDto } from "./dto/create-training.dto";
import { QueryTrainingSetResponseDto } from "./dto/query-training-set-response.dto";
import { SetCurrentTrainingResponseDto } from "./dto/set-current-training-response.dto";
import { TrainingMetaDto } from "./dto/training-meta.dto";
import { UpdateTrainingDto } from "./dto/update-training.dto";
import { TrainingEntity } from "./entities/training.entity";
import { toChapterMetaDto, toTrainingMetaDto } from "./training.mapper";
import { TrainingProgressService } from "./training-progress.service";
import { QueryTrainingRanklistResponseDto } from "./dto/query-training-ranklist.dto";

interface ReorderItem {
  id: number;
  sortOrder: number;
}

@Injectable()
export class TrainingService {
  constructor(
    @InjectRepository(TrainingEntity)
    private readonly trainingRepository: Repository<TrainingEntity>,

    @InjectRepository(UserEntity)
    private readonly userRepository: Repository<UserEntity>,

    private readonly trainingProgressService: TrainingProgressService,
    private readonly userService: UserService
  ) {}

  async queryTrainingSet(currentUser: UserEntity): Promise<QueryTrainingSetResponseDto> {
    const trainings = await this.trainingRepository.find({ order: { sortOrder: "ASC" } });
    const progress = await this.trainingProgressService.getTrainingProgressByIds(
      currentUser,
      trainings.map(training => training.id)
    );
    return {
      result: trainings.map(training => ({
        ...toTrainingMetaDto(training),
        ...progress.get(training.id)
      })),
      count: trainings.length
    };
  }

  async createTraining(createTrainingDto: CreateTrainingDto): Promise<TrainingMetaDto> {
    const training = this.trainingRepository.create(createTrainingDto);
    const savedTraining = await this.trainingRepository.save(training);

    return { ...toTrainingMetaDto(savedTraining) };
  }

  async updateTraining(id: number, updateTrainingDto: UpdateTrainingDto): Promise<TrainingMetaDto> {
    // preload() 是 TypeORM 里的一个方法，常用于更新数据前，先根据 id 查出原来的实体，再把新数据合并进去。
    const training = await this.trainingRepository.preload({
      id,
      ...updateTrainingDto
    });
    if (!training) throw new NotFoundException(`training ${id} not found`);
    const updatedTraining = await this.trainingRepository.save(training);
    return { ...toTrainingMetaDto(updatedTraining) };
  }

  async getTrainingById(id: number, currentUser: UserEntity): Promise<TrainingMetaDto> {
    const training = await this.trainingRepository.findOneBy({ id });
    if (!training) throw new NotFoundException(`training ${id} not found`);

    const chapters = await training.chapters;
    chapters.sort((a, b) => a.sortOrder - b.sortOrder);
    const [trainingProgress, chapterProgress] = await Promise.all([
      this.trainingProgressService.getTrainingProgressByIds(currentUser, [training.id]),
      this.trainingProgressService.getChapterProgressByIds(
        currentUser,
        chapters.map(chapter => chapter.id)
      )
    ]);

    return {
      ...toTrainingMetaDto(training),
      ...trainingProgress.get(training.id),
      chapters: chapters.map(chapter => ({ ...toChapterMetaDto(chapter), ...chapterProgress.get(chapter.id) }))
    };
  }

  async queryTrainingRanklist(
    trainingId: number,
    skipCount: number,
    takeCount: number,
    currentUser: UserEntity
  ): Promise<QueryTrainingRanklistResponseDto> {
    const training = await this.trainingRepository.findOneBy({ id: trainingId });
    if (!training) throw new NotFoundException(`training ${trainingId} not found`);

    const { manager } = this.trainingRepository;
    const ranklistSql = `
      SELECT
        ranked.submitterId,
        ranked.acceptedProblemCount,
        ranked.lastSubmissionTime,
        ranked.\`rank\`,
        ranked.totalCount
      FROM (
        SELECT
          aggregated.*,
          RANK() OVER (ORDER BY aggregated.acceptedProblemCount DESC) AS \`rank\`,
          COUNT(*) OVER () AS totalCount
        FROM (
          SELECT
            submission.submitterId AS submitterId,
            rankedUser.username AS username,
            COUNT(DISTINCT CASE
              WHEN submission.status = ? THEN submission.problemId
              ELSE NULL
            END) AS acceptedProblemCount,
            MAX(submission.submitTime) AS lastSubmissionTime
          FROM submission
          INNER JOIN \`user\` rankedUser
            ON rankedUser.id = submission.submitterId
            AND rankedUser.isAdmin = 0
          INNER JOIN (
            SELECT DISTINCT sectionProblem.problemId AS problemId
            FROM section_problem sectionProblem
            INNER JOIN section trainingSection ON trainingSection.id = sectionProblem.sectionId
            INNER JOIN chapter trainingChapter ON trainingChapter.id = trainingSection.chapterId
            WHERE trainingChapter.trainingId = ?
          ) trainingProblem ON trainingProblem.problemId = submission.problemId
          GROUP BY submission.submitterId, rankedUser.username
        ) aggregated
      ) ranked
      ORDER BY
        ranked.acceptedProblemCount DESC,
        ranked.username ASC,
        ranked.submitterId ASC
      LIMIT ? OFFSET ?
    `;

    type RawRanklistRow = {
      submitterId: string;
      acceptedProblemCount: string;
      lastSubmissionTime: Date;
      rank: string;
      totalCount: string;
    };

    const queryRanklistRows = async (limit: number, offset: number): Promise<RawRanklistRow[]> =>
      await manager.query(ranklistSql, [SubmissionStatus.Accepted, trainingId, limit, offset]);

    const [problemCountRows, initialRanklistRows] = await Promise.all([
      manager.query(
        `
          SELECT COUNT(DISTINCT sectionProblem.problemId) AS problemCount
          FROM section_problem sectionProblem
          INNER JOIN section trainingSection ON trainingSection.id = sectionProblem.sectionId
          INNER JOIN chapter trainingChapter ON trainingChapter.id = trainingSection.chapterId
          WHERE trainingChapter.trainingId = ?
        `,
        [trainingId]
      ),
      queryRanklistRows(takeCount, skipCount)
    ]);

    const ranklistRows = initialRanklistRows;
    let count = ranklistRows.length ? Number(ranklistRows[0].totalCount) : 0;

    // A manually entered page can point past the last row. Read one ranked row so
    // the response still contains the correct total for the pagination control.
    if (!ranklistRows.length && skipCount > 0) {
      const firstRow = (await queryRanklistRows(1, 0))[0];
      count = firstRow ? Number(firstRow.totalCount) : 0;
    }

    const users = await this.userService.findUsersByExistingIds(ranklistRows.map(row => Number(row.submitterId)));
    const result = await Promise.all(
      ranklistRows.map(async (row, index) => ({
        rank: Number(row.rank),
        user: await this.userService.getUserMeta(users[index], currentUser),
        acceptedProblemCount: Number(row.acceptedProblemCount),
        lastSubmissionTime: new Date(row.lastSubmissionTime)
      }))
    );

    return {
      trainingId,
      problemCount: Number(problemCountRows[0]?.problemCount || 0),
      count,
      result
    };
  }

  async delTrainingById(id: number): Promise<void> {
    await this.trainingRepository.manager.transaction(async manager => {
      const trainingRepository = manager.getRepository(TrainingEntity);
      const training = await trainingRepository.findOneBy({ id });
      if (!training) throw new NotFoundException(`training ${id} not found`);

      await trainingRepository.delete(id);

      const remainingTrainings = await trainingRepository.find({
        order: { sortOrder: "ASC", id: "ASC" }
      });
      await Promise.all(
        remainingTrainings.map((remainingTraining, index) => {
          const sortOrder = index + 1;
          if (remainingTraining.sortOrder === sortOrder) return Promise.resolve();
          return trainingRepository.update(remainingTraining.id, { sortOrder });
        })
      );
    });
  }

  async reorderTrainings(items: ReorderItem[]): Promise<void> {
    this.validateReorderItems(items);
    const existingTrainings = await this.trainingRepository.findByIds(items.map(item => item.id));
    if (existingTrainings.length !== items.length) {
      throw new NotFoundException("some trainings not found");
    }

    await this.trainingRepository.manager.transaction(async manager => {
      await Promise.all(
        items.map(item => manager.update(TrainingEntity, { id: item.id }, { sortOrder: item.sortOrder }))
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

  async setCurrentTraining(
    currentUser: UserEntity,
    trainingId?: number | null
  ): Promise<SetCurrentTrainingResponseDto> {
    if (trainingId !== undefined && trainingId !== null) {
      const training = await this.trainingRepository.findOneBy({ id: trainingId });
      if (!training) throw new NotFoundException(`training ${trainingId} not found`);
    }

    const currentTrainingId = trainingId ?? null;

    await this.userRepository.update(currentUser.id, { currentTrainingId });

    currentUser.currentTrainingId = currentTrainingId;
    return { success: true, currentTrainingId };
  }
}
