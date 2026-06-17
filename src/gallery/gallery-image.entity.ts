import { Entity, PrimaryGeneratedColumn, Column, Index, ManyToOne, JoinColumn } from "typeorm";

import { UserEntity } from "@/user/user.entity";

@Entity("gallery_image")
@Index(["ownerId", "createdAt"])
export class GalleryImageEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => UserEntity, { onDelete: "CASCADE" })
  @JoinColumn()
  owner: Promise<UserEntity>;

  @Column()
  @Index()
  ownerId: number;

  @Column({ type: "char", length: 36 })
  @Index({ unique: true })
  uuid: string;

  @Column({ type: "char", length: 36, nullable: true })
  @Index({ unique: true })
  publicId?: string;

  @Column({ type: "varchar", length: 256 })
  filename: string;

  @Column({ type: "varchar", length: 40 })
  mimeType: string;

  @Column({ type: "integer" })
  size: number;

  @Column({ type: "integer", nullable: true })
  width?: number;

  @Column({ type: "integer", nullable: true })
  height?: number;

  @Column({ type: "datetime" })
  @Index()
  createdAt: Date;
}
