import { Column, Entity, Index, JoinColumn, OneToOne, PrimaryColumn } from "typeorm";

import { SubmissionEntity } from "./submission.entity";

@Entity("remote_submission_completion")
export class RemoteSubmissionCompletionEntity {
  @PrimaryColumn()
  submissionId: number;

  @OneToOne(() => SubmissionEntity, { onDelete: "CASCADE" })
  @JoinColumn()
  submission: Promise<SubmissionEntity>;

  @Column({ type: "boolean" })
  firstAccepted: boolean;

  @Column({ type: "integer", default: 0 })
  failures: number;

  @Column({ type: "datetime" })
  @Index()
  nextAttemptAt: Date;
}
