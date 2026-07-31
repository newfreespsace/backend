import { Entity, PrimaryGeneratedColumn, Index, ManyToOne, Column, JoinColumn } from "typeorm";

import { SubmissionStatus } from "@/submission/submission-status.enum";
import type { ContestSubmissionPhase } from "@/submission/submission.entity";
import { UserEntity } from "@/user/user.entity";

import { ContestEntity } from "./contest.entity";

export enum ContestRanklistScope {
  Official = "official",
  Combined = "combined"
}

export interface ContestPlayerScoreDetail {
  score?: number;
  status?: SubmissionStatus;
  submissionId?: number;
  submissions?: Record<
    string,
    {
      submissionId: number;
      status: SubmissionStatus;
      score?: number;
      accepted?: boolean;
      compiled?: boolean;
      time: string;
      contestPhase?: ContestSubmissionPhase;
    }
  >;
  accepted?: boolean;
  unacceptedCount?: number;
  acceptedTime?: string;
  weightedScore?: number;
}

@Entity("contest_player")
@Index(["contestId", "userId", "ranklistScope"], { unique: true })
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

  @Column({ type: "enum", enum: ContestRanklistScope, default: ContestRanklistScope.Official })
  @Index()
  ranklistScope: ContestRanklistScope;

  @Column({ type: "integer" })
  score: number;

  @Column({ type: "integer" })
  timeSpent: number;

  @Column({ type: "json" })
  scoreDetails: Record<string, ContestPlayerScoreDetail>;
}
