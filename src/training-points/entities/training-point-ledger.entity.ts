import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

export enum TrainingPointChangeReason {
  FirstAccepted = "FIRST_ACCEPTED",
  LostAccepted = "LOST_ACCEPTED",
  TrainingPointsChanged = "TRAINING_POINTS_CHANGED",
  ProblemAddedToTraining = "PROBLEM_ADDED_TO_TRAINING",
  ProblemRemovedFromTraining = "PROBLEM_REMOVED_FROM_TRAINING",
  ProblemMovedBetweenTrainings = "PROBLEM_MOVED_BETWEEN_TRAININGS",
  TrainingDeleted = "TRAINING_DELETED",
  ChapterDeleted = "CHAPTER_DELETED",
  SectionDeleted = "SECTION_DELETED",
  ProblemDeleted = "PROBLEM_DELETED",
  CheatingRevoked = "CHEATING_REVOKED",
  InitialBackfill = "INITIAL_BACKFILL",
  FullRecalculation = "FULL_RECALCULATION"
}

@Entity("training_point_ledger")
export class TrainingPointLedgerEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: "integer" })
  @Index()
  userId: number;

  @Column({ type: "integer" })
  @Index()
  problemId: number;

  @Column({ type: "integer", nullable: true })
  sourceTrainingId: number | null;

  @Column({ type: "integer", nullable: true })
  submissionId: number | null;

  @Column({ type: "integer" })
  beforePoints: number;

  @Column({ type: "integer" })
  afterPoints: number;

  @Column({ type: "integer" })
  delta: number;

  @Column({ type: "enum", enum: TrainingPointChangeReason })
  @Index()
  reason: TrainingPointChangeReason;

  @Column({ type: "varchar", length: 255, nullable: true })
  trainingTitleSnapshot: string | null;

  @Column({ type: "integer", nullable: true })
  problemDisplayIdSnapshot: number | null;

  @Column({ type: "datetime" })
  createdAt: Date;
}
