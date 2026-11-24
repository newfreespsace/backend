import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from "typeorm";

import type { AtcoderStatusUpdate } from "./atcoder-status.parser";
import { RemoteAccountEntity } from "./remote-account.entity";
import type { RemoteSubmission } from "./remote-judge.types";

export interface AtcoderSubmissionState {
  row?: Omit<RemoteSubmission, "sourceCode">;
  update?: AtcoderStatusUpdate;
  detailsFetched?: boolean;
  failures?: number;
  retryAt?: number;
  firstObservedAt?: number;
}

@Entity("atcoder_submission_state")
@Index(["accountId", "pending", "contestId"])
export class AtcoderSubmissionStateEntity {
  @PrimaryColumn()
  accountId: number;

  @ManyToOne(() => RemoteAccountEntity, { onDelete: "CASCADE" })
  @JoinColumn()
  account: Promise<RemoteAccountEntity>;

  @PrimaryColumn({ length: 180 })
  contestId: string;

  @PrimaryColumn({ type: "bigint", unsigned: true })
  submissionId: string;

  @Column({ type: "boolean" })
  pending: boolean;

  @Column({ type: "json" })
  state: AtcoderSubmissionState;
}
