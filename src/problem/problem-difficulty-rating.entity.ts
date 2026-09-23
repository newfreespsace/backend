import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn
} from "typeorm";

import { UserEntity } from "@/user/user.entity";

import { ProblemEntity } from "./problem.entity";

@Entity("problem_difficulty_rating")
@Unique(["problemId", "userId"])
export class ProblemDifficultyRatingEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => ProblemEntity, { onDelete: "CASCADE" })
  @JoinColumn()
  problem: Promise<ProblemEntity>;

  @Column()
  @Index()
  problemId: number;

  @ManyToOne(() => UserEntity, { onDelete: "CASCADE" })
  @JoinColumn()
  user: Promise<UserEntity>;

  @Column()
  @Index()
  userId: number;

  @Column({ type: "integer" })
  score: number;

  @UpdateDateColumn({ type: "datetime" })
  updatedAt: Date;
}
