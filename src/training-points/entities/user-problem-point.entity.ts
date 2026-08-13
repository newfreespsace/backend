import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from "typeorm";

import { UserEntity } from "@/user/user.entity";

@Entity("user_problem_point")
@Index(["userId", "problemId"], { unique: true })
export class UserProblemPointEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: "integer" })
  @Index()
  userId: number;

  @ManyToOne(() => UserEntity, { onDelete: "CASCADE" })
  @JoinColumn({ name: "userId" })
  user: UserEntity;

  @Column({ type: "integer" })
  @Index()
  problemId: number;

  @Column({ type: "integer" })
  points: number;

  @Column({ type: "integer" })
  sourceTrainingId: number;

  @Column({ type: "datetime" })
  updatedAt: Date;
}
