import { Entity, PrimaryGeneratedColumn, Index, ManyToOne, Column, JoinColumn } from "typeorm";

import { UserEntity } from "@/user/user.entity";

import { ContestEntity } from "./contest.entity";

export interface ContestPlayerScoreDetail {
  score?: number;
  submissionId?: number;
  submissions?: Record<
    string,
    {
      submissionId: number;
      score?: number;
      accepted?: boolean;
      compiled?: boolean;
      time: string;
    }
  >;
  accepted?: boolean;
  unacceptedCount?: number;
  acceptedTime?: string;
  weightedScore?: number;
}

@Entity("contest_player")
@Index(["contestId", "userId"], { unique: true })
export class ContestPlayerEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => ContestEntity, { onDelete: "CASCADE" })
  @JoinColumn()
  contest: Promise<ContestEntity>;

  @Column()
  @Index()
  contestId: number;

  @ManyToOne(() => UserEntity)
  @JoinColumn()
  user: Promise<UserEntity>;

  @Column()
  @Index()
  userId: number;

  @Column({ type: "integer" })
  score: number;

  @Column({ type: "integer" })
  timeSpent: number;

  @Column({ type: "json" })
  scoreDetails: Record<string, ContestPlayerScoreDetail>;
}
