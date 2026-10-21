import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from "typeorm";

import { UserEntity } from "@/user/user.entity";

import { SubmissionMethod } from "./remote-judge.types";

@Entity("remote_account")
@Index(["userId", "platform"], { unique: true })
@Index(["platform", "handleKey"], { unique: true })
@Index(["platform", "activeUntil", "nextSyncAt"])
@Index(["platform", "catchUpRequested", "nextSyncAt"])
export class RemoteAccountEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => UserEntity, { onDelete: "CASCADE" })
  @JoinColumn()
  user: Promise<UserEntity>;

  @Column()
  userId: number;

  @Column({ type: "enum", enum: SubmissionMethod })
  platform: SubmissionMethod;

  @Column({ length: 64 })
  handle: string;

  @Column({ length: 64 })
  handleKey: string;

  @Column({ type: "datetime" })
  verifiedAt: Date;

  @Column({ type: "datetime", nullable: true })
  lastSyncedAt: Date;

  @Column({ type: "datetime" })
  nextSyncAt: Date;

  @Column({ type: "integer", default: 0 })
  catchUpVersion: number;

  @Column({ type: "boolean", default: false })
  catchUpRequested: boolean;

  @Column({ type: "datetime" })
  activeUntil: Date;

  @Column({ type: "varchar", length: 64, default: "0" })
  cursor: string;

  @Column({ type: "json", nullable: true })
  scan: {
    offset: number;
    head: number;
    pendingMin?: number;
    bufferKey?: string;
    importCursor?: string;
    importPending?: boolean;
  };

  @Column({ type: "integer", default: 0 })
  failures: number;

  @Column({ type: "varchar", length: 80, nullable: true })
  lastError: string;

  @Column({ type: "json", nullable: true, select: false })
  codeforcesCredentials: { iv: string; tag: string; ciphertext: string };

  @Column({ type: "boolean", default: false })
  codeforcesSourceEnabled: boolean;

  @Column({ type: "varchar", length: 80, nullable: true })
  codeforcesSourceError: string;

  @Column({ type: "datetime", nullable: true })
  codeforcesSourceRetryAt: Date;

  @Column({ type: "integer", default: 0 })
  codeforcesSummaryVersion: number;
}
