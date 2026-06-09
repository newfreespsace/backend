import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { TrainingController } from "./training.controller";
import { TrainingService } from "./training.service";

import { TrainingEntity } from "./entities/training.entity";
import { ChapterController } from "./chapter.controller";
import { ChapterService } from "./chapter.service";
import { ChapterEntity } from "./entities/chapter.entity";

@Module({
  imports: [TypeOrmModule.forFeature([TrainingEntity, ChapterEntity])],
  controllers: [TrainingController, ChapterController],
  providers: [TrainingService, ChapterService]
})
export class TrainingModule {}
