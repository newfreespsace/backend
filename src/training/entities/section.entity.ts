import { Column, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryGeneratedColumn } from "typeorm";

import { ChapterEntity } from "./chapter.entity";
import { SectionProblemEntity } from "./section_problem.entity";

@Entity("section")
export class SectionEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  chapterId: number;

  @Column()
  title: string;

  @Column({ nullable: true })
  description?: string;

  @ManyToOne(() => ChapterEntity, { onDelete: "CASCADE" })
  @JoinColumn({ name: "chapterId" })
  chapter: Promise<ChapterEntity>;

  @OneToMany(() => SectionProblemEntity, sectionProblem => sectionProblem.section)
  problems: Promise<SectionProblemEntity[]>;

  @Column()
  sortOrder: number;
}
