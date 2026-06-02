import { Entity, PrimaryGeneratedColumn, Index, ManyToOne, Column, JoinColumn } from "typeorm";

import { UserEntity } from "@/user/user.entity";

export enum ContestType {
  NOI = "noi",
  IOI = "ioi",
  ACM = "acm"
}

@Entity("contest")
export class ContestEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: "varchar", length: 80 })
  title: string;

  @Column({ type: "text" })
  subtitle: string;

  @Column({ type: "text" })
  information: string;

  @Column({ type: "datetime" })
  @Index()
  startTime: Date;

  @Column({ type: "datetime" })
  @Index()
  endTime: Date;

  @Column({ type: "enum", enum: ContestType })
  type: ContestType;

  @Column({ type: "boolean" })
  @Index()
  isPublic: boolean;

  @Column({ type: "boolean" })
  hideStatistics: boolean;

  @ManyToOne(() => UserEntity)
  @JoinColumn()
  holder: Promise<UserEntity>;

  @Column()
  @Index()
  holderId: number;

  @Column({ type: "json" })
  problemIds: number[];

  @Column({ type: "json" })
  adminIds: number[];

  @Column({ type: "json", nullable: true })
  rankingParams: Record<string, number>;
}
