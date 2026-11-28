import { Column, Entity, Index, PrimaryColumn, PrimaryGeneratedColumn } from "typeorm";

import { SubmissionStatus } from "@/submission/submission-status.enum";
import { SubmissionProgress } from "@/submission/submission-progress.interface";

import type { HackProgram, HackSnapshot } from "./hack.types";

@Entity("problem_hack_profile")
export class ProblemHackProfileEntity {
  @PrimaryColumn()
  problemId: number;

  @Column({ default: false })
  enabled: boolean;

  @Column({ default: 1048576 })
  inputLimit: number;

  @Column({ type: "json", nullable: true })
  validator: HackProgram;

  @Column({ type: "json", nullable: true })
  reference: HackProgram;
}

export enum HackState {
  Queued = "Queued",
  Running = "Running",
  Succeeded = "Succeeded",
  Failed = "Failed",
  InvalidInput = "InvalidInput",
  JudgeError = "JudgeError",
  Canceled = "Canceled",
  Obsolete = "Obsolete"
}

@Entity("hack_attempt")
@Index(["challengerId", "quotaDay", "charged"])
@Index(["state", "leaseUntil", "id"])
@Index(["targetSubmissionId", "id"])
@Index(["contestId", "state", "createdAt"])
@Index(["challengerId", "targetSubmissionId", "targetRevision", "snapshotHash", "inputHash"], { unique: true })
export class HackAttemptEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  challengerId: number;

  @Column()
  targetSubmissionId: number;

  @Column()
  targetUserId: number;

  @Column()
  problemId: number;

  @Column({ type: "int", nullable: true })
  contestId: number;

  @Column({ type: "varchar", length: 36 })
  targetRevision: string;

  @Column({ type: "char", length: 64 })
  snapshotHash: string;

  @Column({ type: "char", length: 64 })
  inputHash: string;

  @Column({ type: "json", nullable: true, select: false })
  snapshot: HackSnapshot;

  @Column({ type: "mediumblob", nullable: true, select: false })
  input: Buffer;

  @Column({ type: "mediumblob", nullable: true, select: false })
  output: Buffer;

  @Column({ type: "enum", enum: HackState })
  state: HackState;

  @Column({ type: "varchar", length: 32, nullable: true })
  verdict: SubmissionStatus;

  @Column({ type: "varchar", length: 36, nullable: true })
  @Index({ unique: true })
  taskId: string;

  @Column({ type: "varchar", length: 80, nullable: true })
  worker: string;

  @Column({ type: "datetime", nullable: true })
  leaseUntil: Date;

  @Column({ type: "datetime", nullable: true })
  deadline: Date;

  @Column({ default: 0 })
  runs: number;

  @Column({ type: "char", length: 8 })
  quotaDay: string;

  @Column({ default: true })
  charged: boolean;

  @Column({ type: "datetime" })
  createdAt: Date;

  @Column({ type: "datetime", nullable: true })
  finishedAt: Date;

  @Column({ type: "datetime", nullable: true })
  revokedAt: Date;

  @Column({ type: "int", nullable: true })
  revokedBy: number;

  @Column({ type: "varchar", length: 500, nullable: true })
  revokeReason: string;

  @Column({ type: "json", nullable: true, select: false })
  regularResult: SubmissionProgress;

  @Column({ type: "integer", nullable: true })
  effectiveScore: number;

  @Column({ default: false })
  @Index()
  needsRefresh: boolean;

  @Column({ type: "varchar", length: 36, nullable: true })
  refreshRevision: string;

  @Column({ default: false })
  replay: boolean;

  @Column({ default: false })
  recheckFailed: boolean;
}
