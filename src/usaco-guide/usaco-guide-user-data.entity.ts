import { Column, Entity, JoinColumn, OneToOne, PrimaryColumn } from "typeorm";

import { UserEntity } from "@/user/user.entity";

@Entity("usaco_guide_user_data")
export class UsacoGuideUserDataEntity {
  @PrimaryColumn()
  userId: number;

  @OneToOne(() => UserEntity, { onDelete: "CASCADE" })
  @JoinColumn({ name: "userId" })
  user: Promise<UserEntity>;

  @Column({ type: "integer", default: 1 })
  schemaVersion: number;

  @Column({ type: "json" })
  data: Record<string, unknown>;

  @Column({ type: "integer", default: 1 })
  revision: number;

  @Column({ type: "datetime" })
  createdAt: Date;

  @Column({ type: "datetime" })
  updatedAt: Date;
}
