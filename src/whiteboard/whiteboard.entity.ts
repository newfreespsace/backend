import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from "typeorm";

import { UserEntity } from "@/user/user.entity";

@Entity("whiteboard")
@Index(["userId", "updatedAt"])
export class WhiteboardEntity {
  @PrimaryColumn({ type: "char", length: 36 })
  id: string;

  @ManyToOne(() => UserEntity, { onDelete: "CASCADE" })
  @JoinColumn()
  user: Promise<UserEntity>;

  @Column()
  userId: number;

  @Column({ length: 120 })
  title: string;

  // Keep images and elements in one atomic snapshot.
  @Column({ type: "longtext", select: false })
  scene: string;

  @Column({ type: "integer" })
  version: number;

  @Column({ type: "datetime" })
  createdAt: Date;

  @Column({ type: "datetime" })
  updatedAt: Date;
}
