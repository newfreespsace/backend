import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from "typeorm";

import { RemoteAccountEntity } from "./remote-account.entity";
import { RemoteSubmission } from "./remote-judge.types";

// Private staging area: collect all pages before assigning ordinary submission IDs.
@Entity("codeforces_import_buffer")
@Index(["accountId", "batch", "submittedAt", "remoteId"])
export class CodeforcesImportBufferEntity {
  @ManyToOne(() => RemoteAccountEntity, { onDelete: "CASCADE" })
  @JoinColumn()
  account: Promise<RemoteAccountEntity>;

  @PrimaryColumn()
  accountId: number;

  @PrimaryColumn({ type: "char", length: 24 })
  batch: string;

  @PrimaryColumn({ type: "bigint", unsigned: true })
  remoteId: string;

  @Column({ type: "double" })
  submittedAt: number;

  @Column({ type: "json", select: false })
  payload: RemoteSubmission;
}
