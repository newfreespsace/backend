import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from "typeorm";

import { ProblemEntity } from "@/problem/problem.entity";

import { SectionEntity } from "./section.entity";

export enum SectionProblemCategory {
  Example = "Example",
  Exercise = "Exercise"
}

@Entity("section_problem")
@Index(["sectionId", "problemId"], { unique: true })
@Index(["sectionId", "category", "sortOrder"], { unique: true })
export class SectionProblemEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  sectionId: number;

  // 当前实体 SectionProblem 和 Section 是多对一关系。
  // 如果这个 section 被删除，那么它下面的 section_problem 关联记录也自动删除。
  @ManyToOne(() => SectionEntity, { onDelete: "CASCADE" })
  @JoinColumn({ name: "sectionId" })
  section: Promise<SectionEntity>;

  @Column()
  problemId: number;

  @ManyToOne(() => ProblemEntity, { onDelete: "CASCADE" })
  @JoinColumn({ name: "problemId" })
  problem: Promise<ProblemEntity>;

  @Column({ type: "enum", enum: SectionProblemCategory, default: SectionProblemCategory.Exercise })
  category: SectionProblemCategory;

  @Column()
  sortOrder: number;
}
