import { Injectable, Logger } from "@nestjs/common";
import { InjectDataSource, InjectRepository } from "@nestjs/typeorm";

import { DataSource, EntityManager, In, Repository } from "typeorm";

import { LockService } from "@/redis/lock.service";
import { SubmissionStatus } from "@/submission/submission-status.enum";

import { TrainingPointLedgerEntity, TrainingPointChangeReason } from "./entities/training-point-ledger.entity";
import {
  TrainingPointRecalculationStatus,
  TrainingPointRecalculationSummary,
  TrainingPointRecalculationTaskEntity
} from "./entities/training-point-recalculation-task.entity";
import { UserProblemPointEntity } from "./entities/user-problem-point.entity";

import { TrainingPointRecalculationTaskDto } from "./dto";

const GLOBAL_POINT_LOCK = "TrainingPoints";
const START_RECALCULATION_LOCK = "StartTrainingPointRecalculation";
const RECALCULATION_HEARTBEAT_INTERVAL = 10_000;
const RECALCULATION_STALE_AFTER = 5 * 60_000;

interface ExpectedPointRow {
  userId: number;
  problemId: number;
  points: number;
  sourceTrainingId: number;
}

interface EffectiveProblemPoints {
  points: number;
  sourceTrainingId: number;
}

interface UserRatingRow {
  id: string;
  rating: string;
}

@Injectable()
export class TrainingPointService {
  private readonly logger = new Logger(TrainingPointService.name);

  constructor(
    @InjectDataSource()
    private readonly connection: DataSource,
    @InjectRepository(UserProblemPointEntity)
    private readonly userProblemPointRepository: Repository<UserProblemPointEntity>,
    @InjectRepository(TrainingPointRecalculationTaskEntity)
    private readonly recalculationTaskRepository: Repository<TrainingPointRecalculationTaskEntity>,
    private readonly lockService: LockService
  ) {}

  toTaskDto(task: TrainingPointRecalculationTaskEntity): TrainingPointRecalculationTaskDto {
    return {
      id: task.id,
      dryRun: task.dryRun,
      status: task.status,
      summary: task.summary || undefined,
      error: task.error || undefined,
      createdAt: task.createdAt,
      startedAt: task.startedAt || undefined,
      finishedAt: task.finishedAt || undefined
    };
  }

  async startRecalculation(
    requestedByUserId: number,
    dryRun: boolean
  ): Promise<TrainingPointRecalculationTaskEntity | null> {
    return await this.lockService.lock(START_RECALCULATION_LOCK, async () => {
      const activeTasks = await this.recalculationTaskRepository.findBy({
        status: In([TrainingPointRecalculationStatus.Pending, TrainingPointRecalculationStatus.Running])
      });
      const staleBefore = Date.now() - RECALCULATION_STALE_AFTER;
      const staleTasks = activeTasks.filter(
        task => (task.heartbeatAt || task.startedAt || task.createdAt).getTime() < staleBefore
      );
      if (staleTasks.length > 0) {
        const now = new Date();
        staleTasks.forEach(task => {
          task.status = TrainingPointRecalculationStatus.Failed;
          task.error = "Task interrupted before completion";
          task.finishedAt = now;
          task.heartbeatAt = now;
        });
        await this.recalculationTaskRepository.save(staleTasks);
      }
      if (activeTasks.length > staleTasks.length) return null;

      const task = this.recalculationTaskRepository.create({
        requestedByUserId,
        dryRun,
        status: TrainingPointRecalculationStatus.Pending,
        summary: null,
        error: null,
        createdAt: new Date(),
        startedAt: null,
        finishedAt: null,
        heartbeatAt: new Date()
      });
      await this.recalculationTaskRepository.save(task);

      setImmediate(() => {
        this.runRecalculationTask(task.id).catch(error => {
          this.logger.error(`Unhandled training point recalculation error for task ${task.id}`, error?.stack || error);
        });
      });

      return task;
    });
  }

  async getRecalculationTask(id?: number): Promise<TrainingPointRecalculationTaskEntity> {
    const task =
      id !== undefined
        ? await this.recalculationTaskRepository.findOneBy({ id })
        : await this.recalculationTaskRepository.findOne({ order: { id: "DESC" } });
    if (
      task &&
      [TrainingPointRecalculationStatus.Pending, TrainingPointRecalculationStatus.Running].includes(task.status) &&
      (task.heartbeatAt || task.startedAt || task.createdAt).getTime() < Date.now() - RECALCULATION_STALE_AFTER
    ) {
      task.status = TrainingPointRecalculationStatus.Failed;
      task.error = "Task interrupted before completion";
      task.finishedAt = new Date();
      task.heartbeatAt = task.finishedAt;
      await this.recalculationTaskRepository.save(task);
    }
    return task;
  }

  async getActiveRecalculationTask(): Promise<TrainingPointRecalculationTaskEntity> {
    return await this.recalculationTaskRepository.findOne({
      where: { status: In([TrainingPointRecalculationStatus.Pending, TrainingPointRecalculationStatus.Running]) },
      order: { id: "DESC" }
    });
  }

  private async runRecalculationTask(taskId: number): Promise<void> {
    const task = await this.getRecalculationTask(taskId);
    if (!task || task.status !== TrainingPointRecalculationStatus.Pending) return;

    task.status = TrainingPointRecalculationStatus.Running;
    task.startedAt = new Date();
    task.heartbeatAt = new Date();
    await this.recalculationTaskRepository.save(task);

    const heartbeatTimer = setInterval(() => {
      this.recalculationTaskRepository
        .update({ id: task.id, status: TrainingPointRecalculationStatus.Running }, { heartbeatAt: new Date() })
        .catch(error => this.logger.warn(`Unable to update heartbeat for training point task ${task.id}: ${error}`));
    }, RECALCULATION_HEARTBEAT_INTERVAL);
    heartbeatTimer.unref();

    try {
      task.summary = await this.lockService.lockReadWrite(
        GLOBAL_POINT_LOCK,
        task.dryRun ? "Read" : "Write",
        async () => await this.recalculateAll(task.dryRun)
      );
      task.status = TrainingPointRecalculationStatus.Succeeded;
    } catch (error) {
      task.status = TrainingPointRecalculationStatus.Failed;
      task.error = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `Training point recalculation task ${task.id} failed`,
        error instanceof Error ? error.stack : String(error)
      );
    } finally {
      clearInterval(heartbeatTimer);
    }

    task.finishedAt = new Date();
    task.heartbeatAt = task.finishedAt;
    await this.recalculationTaskRepository.save(task);
  }

  async reconcileUserProblem(
    userId: number,
    problemId: number,
    reason: TrainingPointChangeReason,
    submissionId?: number
  ): Promise<void> {
    await this.withGlobalPointLock(
      "Read",
      async () =>
        await this.lockService.lock(
          `TrainingPointUser_${userId}`,
          async () => await this.reconcileUserProblemInternal(userId, problemId, reason, submissionId)
        )
    );
  }

  async reconcileProblems(
    problemIds: number[],
    reason: TrainingPointChangeReason,
    trainingTitleSnapshots?: Map<number, string>
  ): Promise<void> {
    const uniqueProblemIds = Array.from(new Set(problemIds));
    if (uniqueProblemIds.length === 0) return;

    await this.withGlobalPointLock("Read", async () => {
      const placeholders = uniqueProblemIds.map(() => "?").join(",");
      const rows: { userId: string; problemId: string }[] = await this.connection.manager.query(
        `
          SELECT DISTINCT submission.submitterId AS userId, submission.problemId AS problemId
          FROM submission
          WHERE submission.status = ? AND submission.problemId IN (${placeholders})
          UNION
          SELECT currentPoint.userId AS userId, currentPoint.problemId AS problemId
          FROM user_problem_point currentPoint
          WHERE currentPoint.problemId IN (${placeholders})
        `,
        [SubmissionStatus.Accepted, ...uniqueProblemIds, ...uniqueProblemIds]
      );

      for (const row of rows) {
        const userId = Number(row.userId);
        const problemId = Number(row.problemId);
        // eslint-disable-next-line no-await-in-loop
        await this.lockService.lock(
          `TrainingPointUser_${userId}`,
          async () =>
            await this.reconcileUserProblemInternal(userId, problemId, reason, undefined, trainingTitleSnapshots)
        );
      }
    });
  }

  async clearDeletedProblemPoints(problemId: number, problemDisplayId: number | null): Promise<void> {
    await this.withGlobalPointLock("Write", async () => {
      await this.connection.transaction("READ COMMITTED", async manager => {
        const currentPoints = await manager.findBy(UserProblemPointEntity, { problemId });
        if (currentPoints.length === 0) return;

        const sourceTrainingIds = Array.from(new Set(currentPoints.map(point => point.sourceTrainingId)));
        const trainingRows: { id: string; title: string }[] = sourceTrainingIds.length
          ? await manager.query(
              `SELECT id, title FROM training WHERE id IN (${sourceTrainingIds.map(() => "?").join(",")})`,
              sourceTrainingIds
            )
          : [];
        const trainingTitles = new Map(trainingRows.map(row => [Number(row.id), row.title]));

        await manager.remove(currentPoints);
        await this.synchronizeUserRatings(
          manager,
          currentPoints.map(point => point.userId)
        );
        await manager.save(
          TrainingPointLedgerEntity,
          currentPoints.map(point =>
            manager.create(TrainingPointLedgerEntity, {
              userId: point.userId,
              problemId,
              sourceTrainingId: point.sourceTrainingId,
              submissionId: null,
              beforePoints: point.points,
              afterPoints: 0,
              delta: -point.points,
              reason: TrainingPointChangeReason.ProblemDeleted,
              trainingTitleSnapshot: trainingTitles.get(point.sourceTrainingId) || null,
              problemDisplayIdSnapshot: problemDisplayId,
              createdAt: new Date()
            })
          ),
          { chunk: 500 }
        );
      });
    });
  }

  private async reconcileUserProblemInternal(
    userId: number,
    problemId: number,
    reason: TrainingPointChangeReason,
    submissionId?: number,
    trainingTitleSnapshots?: Map<number, string>
  ): Promise<void> {
    const [acceptedRows, effectivePoints, currentPoint] = await Promise.all([
      this.connection.manager.query(
        "SELECT 1 FROM submission WHERE submitterId = ? AND problemId = ? AND status = ? LIMIT 1",
        [userId, problemId, SubmissionStatus.Accepted]
      ),
      this.getEffectiveProblemPoints(problemId),
      this.userProblemPointRepository.findOneBy({ userId, problemId })
    ]);

    const expectedPoints = acceptedRows.length > 0 && effectivePoints ? effectivePoints.points : 0;
    const currentPoints = currentPoint?.points || 0;
    const sourceChanged =
      expectedPoints > 0 && currentPoint && currentPoint.sourceTrainingId !== effectivePoints.sourceTrainingId;
    const delta = expectedPoints - currentPoints;

    if (delta === 0 && !sourceChanged) return;

    await this.connection.transaction("READ COMMITTED", async manager => {
      if (expectedPoints > 0) {
        const entity = currentPoint || new UserProblemPointEntity();
        entity.userId = userId;
        entity.problemId = problemId;
        entity.points = expectedPoints;
        entity.sourceTrainingId = effectivePoints.sourceTrainingId;
        entity.updatedAt = new Date();
        await manager.save(entity);
      } else if (currentPoint) {
        await manager.remove(currentPoint);
      }

      if (delta !== 0) {
        await this.synchronizeUserRatings(manager, [userId]);
        const ledgerSourceTrainingId =
          delta < 0
            ? currentPoint?.sourceTrainingId || effectivePoints?.sourceTrainingId || null
            : effectivePoints?.sourceTrainingId || currentPoint?.sourceTrainingId || null;
        await this.saveLedger(
          manager,
          userId,
          problemId,
          currentPoints,
          expectedPoints,
          ledgerSourceTrainingId,
          reason,
          submissionId || null,
          trainingTitleSnapshots
        );
      }
    });
  }

  private async getEffectiveProblemPoints(problemId: number): Promise<EffectiveProblemPoints | null> {
    const rows: { points: string; sourceTrainingId: string }[] = await this.connection.manager.query(
      `
        SELECT training.pointsPerProblem AS points, training.id AS sourceTrainingId
        FROM section_problem sectionProblem
        INNER JOIN section trainingSection ON trainingSection.id = sectionProblem.sectionId
        INNER JOIN chapter trainingChapter ON trainingChapter.id = trainingSection.chapterId
        INNER JOIN training training ON training.id = trainingChapter.trainingId
        WHERE sectionProblem.problemId = ? AND training.pointsPerProblem > 0
        ORDER BY training.pointsPerProblem DESC, training.id ASC
        LIMIT 1
      `,
      [problemId]
    );
    if (rows.length === 0) return null;
    return { points: Number(rows[0].points), sourceTrainingId: Number(rows[0].sourceTrainingId) };
  }

  private async calculateExpectedRows(manager: EntityManager): Promise<ExpectedPointRow[]> {
    const rows: { userId: string; problemId: string; points: string; sourceTrainingId: string }[] = await manager.query(
      `
        WITH accepted AS (
          SELECT DISTINCT submission.submitterId AS userId, submission.problemId AS problemId
          FROM submission
          WHERE submission.status = ?
        ), membership AS (
          SELECT DISTINCT
            sectionProblem.problemId AS problemId,
            training.id AS sourceTrainingId,
            training.pointsPerProblem AS points
          FROM section_problem sectionProblem
          INNER JOIN section trainingSection ON trainingSection.id = sectionProblem.sectionId
          INNER JOIN chapter trainingChapter ON trainingChapter.id = trainingSection.chapterId
          INNER JOIN training training ON training.id = trainingChapter.trainingId
          WHERE training.pointsPerProblem > 0
        ), rankedMembership AS (
          SELECT
            membership.*,
            ROW_NUMBER() OVER (
              PARTITION BY membership.problemId
              ORDER BY membership.points DESC, membership.sourceTrainingId ASC
            ) AS rowNumber
          FROM membership
        )
        SELECT accepted.userId, accepted.problemId, rankedMembership.points, rankedMembership.sourceTrainingId
        FROM accepted
        INNER JOIN rankedMembership
          ON rankedMembership.problemId = accepted.problemId AND rankedMembership.rowNumber = 1
      `,
      [SubmissionStatus.Accepted]
    );

    return rows.map(row => ({
      userId: Number(row.userId),
      problemId: Number(row.problemId),
      points: Number(row.points),
      sourceTrainingId: Number(row.sourceTrainingId)
    }));
  }

  private makePointKey(userId: number, problemId: number): string {
    return `${userId}:${problemId}`;
  }

  private makeSummary(
    currentRows: UserProblemPointEntity[],
    expectedRows: ExpectedPointRow[],
    userRatings: UserRatingRow[]
  ): TrainingPointRecalculationSummary {
    const current = new Map(currentRows.map(row => [this.makePointKey(row.userId, row.problemId), row]));
    const expected = new Map(expectedRows.map(row => [this.makePointKey(row.userId, row.problemId), row]));
    const affectedUsers = new Set<number>();
    let addedRecordCount = 0;
    let updatedRecordCount = 0;
    let deletedRecordCount = 0;

    expected.forEach((row, key) => {
      const old = current.get(key);
      if (!old) {
        addedRecordCount++;
        affectedUsers.add(row.userId);
      } else if (old.points !== row.points || old.sourceTrainingId !== row.sourceTrainingId) {
        updatedRecordCount++;
        affectedUsers.add(row.userId);
      }
    });
    current.forEach((row, key) => {
      if (!expected.has(key)) {
        deletedRecordCount++;
        affectedUsers.add(row.userId);
      }
    });
    const expectedTotals = new Map<number, number>();
    expectedRows.forEach(row => expectedTotals.set(row.userId, (expectedTotals.get(row.userId) || 0) + row.points));
    userRatings.forEach(user => {
      if (Number(user.rating) !== (expectedTotals.get(Number(user.id)) || 0)) affectedUsers.add(Number(user.id));
    });

    return {
      affectedUserCount: affectedUsers.size,
      currentRecordCount: currentRows.length,
      expectedRecordCount: expectedRows.length,
      addedRecordCount,
      updatedRecordCount,
      deletedRecordCount,
      beforeTotalPoints: userRatings.reduce((sum, user) => sum + Number(user.rating), 0),
      afterTotalPoints: expectedRows.reduce((sum, row) => sum + row.points, 0),
      validationPassed: affectedUsers.size === 0
    };
  }

  private async recalculateAll(dryRun: boolean): Promise<TrainingPointRecalculationSummary> {
    return await this.connection.transaction("REPEATABLE READ", async manager => {
      const [currentRows, expectedRows, userRatings] = await Promise.all([
        manager.find(UserProblemPointEntity),
        this.calculateExpectedRows(manager),
        manager.query("SELECT id, rating FROM `user`") as Promise<UserRatingRow[]>
      ]);
      const summary = this.makeSummary(currentRows, expectedRows, userRatings);
      if (dryRun) return summary;

      const current = new Map(currentRows.map(row => [this.makePointKey(row.userId, row.problemId), row]));
      const expected = new Map(expectedRows.map(row => [this.makePointKey(row.userId, row.problemId), row]));
      const initialBackfill = currentRows.length === 0;
      const sourceTrainingIds = Array.from(
        new Set([...currentRows.map(row => row.sourceTrainingId), ...expectedRows.map(row => row.sourceTrainingId)])
      );
      const problemIds = Array.from(
        new Set([...currentRows.map(row => row.problemId), ...expectedRows.map(row => row.problemId)])
      );
      const trainingRows: { id: string; title: string }[] = sourceTrainingIds.length
        ? await manager.query(
            `SELECT id, title FROM training WHERE id IN (${sourceTrainingIds.map(() => "?").join(",")})`,
            sourceTrainingIds
          )
        : [];
      const problemRows: { id: string; displayId: string | null }[] = problemIds.length
        ? await manager.query(
            `SELECT id, displayId FROM problem WHERE id IN (${problemIds.map(() => "?").join(",")})`,
            problemIds
          )
        : [];
      const trainingTitles = new Map(trainingRows.map(row => [Number(row.id), row.title]));
      const problemDisplayIds = new Map(
        problemRows.map(row => [Number(row.id), row.displayId === null ? null : Number(row.displayId)])
      );
      const ledgers: TrainingPointLedgerEntity[] = [];
      expected.forEach(row => {
        const old = current.get(this.makePointKey(row.userId, row.problemId));
        if ((old?.points || 0) === row.points) return;
        const delta = row.points - (old?.points || 0);
        const ledgerSourceTrainingId = delta < 0 && old ? old.sourceTrainingId : row.sourceTrainingId;
        ledgers.push(
          manager.create(TrainingPointLedgerEntity, {
            userId: row.userId,
            problemId: row.problemId,
            sourceTrainingId: ledgerSourceTrainingId,
            submissionId: null,
            beforePoints: old?.points || 0,
            afterPoints: row.points,
            delta,
            reason: initialBackfill
              ? TrainingPointChangeReason.InitialBackfill
              : TrainingPointChangeReason.FullRecalculation,
            trainingTitleSnapshot: trainingTitles.get(ledgerSourceTrainingId) || null,
            problemDisplayIdSnapshot: problemDisplayIds.get(row.problemId) ?? null,
            createdAt: new Date()
          })
        );
      });
      current.forEach((row, key) => {
        if (expected.has(key)) return;
        ledgers.push(
          manager.create(TrainingPointLedgerEntity, {
            userId: row.userId,
            problemId: row.problemId,
            sourceTrainingId: row.sourceTrainingId,
            submissionId: null,
            beforePoints: row.points,
            afterPoints: 0,
            delta: -row.points,
            reason: TrainingPointChangeReason.FullRecalculation,
            trainingTitleSnapshot: trainingTitles.get(row.sourceTrainingId) || null,
            problemDisplayIdSnapshot: problemDisplayIds.get(row.problemId) ?? null,
            createdAt: new Date()
          })
        );
      });

      await manager.createQueryBuilder().delete().from(UserProblemPointEntity).execute();
      if (expectedRows.length > 0) {
        await manager.save(
          UserProblemPointEntity,
          expectedRows.map(row =>
            manager.create(UserProblemPointEntity, {
              ...row,
              updatedAt: new Date()
            })
          ),
          { chunk: 500 }
        );
      }
      if (ledgers.length > 0) await manager.save(TrainingPointLedgerEntity, ledgers, { chunk: 500 });

      await manager.query("UPDATE `user` SET rating = 0");
      await manager.query(`
        UPDATE \`user\` userAccount
        INNER JOIN (
          SELECT userId, SUM(points) AS totalPoints
          FROM user_problem_point
          GROUP BY userId
        ) totals ON totals.userId = userAccount.id
        SET userAccount.rating = totals.totalPoints
      `);

      const validationRows: { mismatchCount: string }[] = await manager.query(`
        SELECT COUNT(*) AS mismatchCount
        FROM \`user\` userAccount
        LEFT JOIN (
          SELECT userId, SUM(points) AS totalPoints
          FROM user_problem_point
          GROUP BY userId
        ) totals ON totals.userId = userAccount.id
        WHERE userAccount.rating <> COALESCE(totals.totalPoints, 0)
      `);
      summary.validationPassed = Number(validationRows[0]?.mismatchCount || 0) === 0;
      if (!summary.validationPassed) throw new Error("Training point validation failed after full recalculation");
      return summary;
    });
  }

  private async saveLedger(
    manager: EntityManager,
    userId: number,
    problemId: number,
    beforePoints: number,
    afterPoints: number,
    sourceTrainingId: number | null,
    reason: TrainingPointChangeReason,
    submissionId: number | null,
    trainingTitleSnapshots?: Map<number, string>
  ): Promise<void> {
    const [trainingRows, problemRows] = await Promise.all([
      sourceTrainingId
        ? manager.query("SELECT title FROM training WHERE id = ?", [sourceTrainingId])
        : Promise.resolve([]),
      manager.query("SELECT displayId FROM problem WHERE id = ?", [problemId])
    ]);
    const ledger = manager.create(TrainingPointLedgerEntity, {
      userId,
      problemId,
      sourceTrainingId,
      submissionId,
      beforePoints,
      afterPoints,
      delta: afterPoints - beforePoints,
      reason,
      trainingTitleSnapshot:
        (sourceTrainingId ? trainingTitleSnapshots?.get(sourceTrainingId) : null) || trainingRows[0]?.title || null,
      problemDisplayIdSnapshot:
        problemRows[0]?.displayId === null || problemRows[0]?.displayId === undefined
          ? null
          : Number(problemRows[0].displayId),
      createdAt: new Date()
    });
    await manager.save(ledger);
  }

  private async synchronizeUserRatings(manager: EntityManager, userIds: number[]): Promise<void> {
    const uniqueUserIds = Array.from(new Set(userIds));
    if (uniqueUserIds.length === 0) return;

    await manager.query(
      `
        UPDATE \`user\` userAccount
        LEFT JOIN (
          SELECT userId, SUM(points) AS totalPoints
          FROM user_problem_point
          WHERE userId IN (${uniqueUserIds.map(() => "?").join(",")})
          GROUP BY userId
        ) totals ON totals.userId = userAccount.id
        SET userAccount.rating = COALESCE(totals.totalPoints, 0)
        WHERE userAccount.id IN (${uniqueUserIds.map(() => "?").join(",")})
      `,
      [...uniqueUserIds, ...uniqueUserIds]
    );
  }

  private async withGlobalPointLock<T>(type: "Read" | "Write", callback: () => Promise<T>): Promise<T> {
    for (;;) {
      try {
        // eslint-disable-next-line no-await-in-loop
        return await this.lockService.lockReadWrite(GLOBAL_POINT_LOCK, type, callback);
      } catch (error) {
        if (!(error instanceof Error) || !error.message.startsWith("Retries limit exceeded while attempting to lock"))
          throw error;
        this.logger.log(`Still waiting for the global training point ${type.toLowerCase()} lock`);
      }
    }
  }
}
