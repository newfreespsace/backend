import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from "typeorm";

import { ProblemEntity } from "@/problem/problem.entity";

import { RemoteAccountEntity } from "./remote-account.entity";

// Durable contest context also allows late upstream results to enter the correct ranklist.
@Entity("remote_watch")
@Index(["accountId", "problemId", "startedAt"])
export class RemoteWatchEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => RemoteAccountEntity, { onDelete: "CASCADE" })
  @JoinColumn()
  account: Promise<RemoteAccountEntity>;

  @Column()
  accountId: number;

  @ManyToOne(() => ProblemEntity, { onDelete: "CASCADE" })
  @JoinColumn()
  problem: Promise<ProblemEntity>;

  @Column()
  problemId: number;

  @Column({ default: 0 })
  contestId: number;

  @Column({ type: "datetime" })
  startedAt: Date;

  @Column({ type: "datetime" })
  until: Date;

  @Column({ default: 0 })
  contestProblemIndex: number;
}
