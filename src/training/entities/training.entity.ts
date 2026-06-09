import { Column, Entity, OneToMany, PrimaryGeneratedColumn } from "typeorm";

import { ChapterEntity } from "./chapter.entity";

@Entity("entity") // 没有 @Entity()，TypeORM 只会把它当成一个普通 class，不会生成表结构元数据
export class TrainingEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  title: string;

  @Column({ nullable: true })
  description?: string;

  @Column()
  sortOrder: number;

  // 第一个箭头函数表示这个一对多关系关联的是哪个实体类
  // 第二个箭头函数表示 Chapter 那边的哪个属性是这个关系的反向关系
  @OneToMany(() => ChapterEntity, chapter => chapter.training)
  chapters: Promise<ChapterEntity[]>;
}
