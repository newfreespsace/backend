import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from "typeorm";

import { ProblemEntity } from "@/problem/problem.entity";
import { UserEntity } from "@/user/user.entity";

@Entity("user_problem_review")
@Index(["userId", "problemId"], { unique: true })
@Index(["userId", "completedReviewCount", "availableAt"])
@Index(["userId", "dueAt"])
export class ProblemReviewEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => UserEntity, { onDelete: "CASCADE" })
  @JoinColumn()
  user: Promise<UserEntity>;

  @Column()
  userId: number;

  @ManyToOne(() => ProblemEntity, { onDelete: "CASCADE" })
  @JoinColumn()
  problem: Promise<ProblemEntity>;

  @Column()
  problemId: number;

  @Column({ type: "integer", default: 0 })
  completedReviewCount: number;

  @Column({ type: "integer" })
  firstAcceptedSubmissionId: number;

  @Column({ type: "integer", nullable: true })
  sourceContestId: number;

  @Column({ type: "integer", nullable: true })
  sourceContestProblemIndex: number;

  @Column({ type: "datetime" })
  firstAcceptedAt: Date;

  @Column({ type: "datetime", nullable: true })
  lastReviewedAt: Date;

  @Column({ type: "datetime" })
  availableAt: Date;

  @Column({ type: "datetime" })
  dueAt: Date;

  @Column({ type: "integer", nullable: true })
  lastReviewSubmissionId: number;

  @Column({ type: "datetime", nullable: true })
  completedAt: Date;

  @Column({ type: "datetime" })
  createdAt: Date;

  @Column({ type: "datetime" })
  updatedAt: Date;
}
