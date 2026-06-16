import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { ProblemModule } from "@/problem/problem.module";
import { SubmissionModule } from "@/submission/submission.module";
import { SubmissionEntity } from "@/submission/submission.entity";
import { UserModule } from "@/user/user.module";
import { GroupModule } from "@/group/group.module";

import { UserEntity } from "@/user/user.entity";

import { TrainingController } from "./training.controller";
import { TrainingService } from "./training.service";
import { TrainingEntity } from "./entities/training.entity";
import { ChapterController } from "./chapter.controller";
import { ChapterService } from "./chapter.service";
import { ChapterEntity } from "./entities/chapter.entity";
import { SectionEntity } from "./entities/section.entity";
import { SectionController } from "./section.controller";
import { SectionService } from "./section.service";
import { SectionProblemEntity } from "./entities/section_problem.entity";
import { TrainingProgressService } from "./training-progress.service";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      TrainingEntity,
      ChapterEntity,
      SectionEntity,
      SectionProblemEntity,
      SubmissionEntity,
      UserEntity
    ]),
    ProblemModule,
    SubmissionModule,
    UserModule,
    GroupModule
  ],
  controllers: [TrainingController, ChapterController, SectionController],
  providers: [TrainingService, ChapterService, SectionService, TrainingProgressService]
})
export class TrainingModule {}
