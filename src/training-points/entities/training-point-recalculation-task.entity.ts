import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

export enum TrainingPointRecalculationStatus {
  Pending = "PENDING",
  Running = "RUNNING",
  Succeeded = "SUCCEEDED",
  Failed = "FAILED"
}

export interface TrainingPointRecalculationSummary {
  affectedUserCount: number;
  currentRecordCount: number;
  expectedRecordCount: number;
  addedRecordCount: number;
  updatedRecordCount: number;
  deletedRecordCount: number;
  beforeTotalPoints: number;
  afterTotalPoints: number;
  validationPassed: boolean;
}

@Entity("training_point_recalculation_task")
export class TrainingPointRecalculationTaskEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: "integer" })
  @Index()
  requestedByUserId: number;

  @Column({ type: "boolean" })
  dryRun: boolean;

  @Column({ type: "enum", enum: TrainingPointRecalculationStatus })
  @Index()
  status: TrainingPointRecalculationStatus;

  @Column({ type: "json", nullable: true })
  summary: TrainingPointRecalculationSummary | null;

  @Column({ type: "text", nullable: true })
  error: string | null;

  @Column({ type: "datetime" })
  createdAt: Date;

  @Column({ type: "datetime", nullable: true })
  startedAt: Date | null;

  @Column({ type: "datetime", nullable: true })
  finishedAt: Date | null;

  @Column({ type: "datetime", nullable: true })
  heartbeatAt: Date | null;
}
