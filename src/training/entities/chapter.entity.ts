import { Column, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from "typeorm";

import { TrainingEntity } from "./training.entity";
import { SectionEntity } from "./section.entity";

@Entity("chapter")
export class ChapterEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  trainingId: number;

  @ManyToOne(() => TrainingEntity, { onDelete: "CASCADE" })
  @JoinColumn({ name: "trainingId" })
  training: Promise<TrainingEntity>;

  @Column()
  title: string;

  @Column({ nullable: true })
  description?: string;

  @OneToMany(() => SectionEntity, section => section.chapter)
  sections: Promise<SectionEntity[]>;

  @Column()
  sortOrder: number;
}
