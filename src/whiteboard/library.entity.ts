import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from "typeorm";
import { UserEntity } from "@/user/user.entity";

@Entity("whiteboard_library")
export class WhiteboardLibraryEntity {
  @PrimaryColumn()
  userId: number;

  @ManyToOne(() => UserEntity, { onDelete: "CASCADE" })
  @JoinColumn({ name: "userId" })
  user: Promise<UserEntity>;

  @Column({ type: "longtext" })
  items: string;

  @Column({ type: "integer" })
  version: number;
}
