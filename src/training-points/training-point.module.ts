import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { RedisModule } from "@/redis/redis.module";

import { TrainingPointLedgerEntity } from "./entities/training-point-ledger.entity";
import { TrainingPointRecalculationTaskEntity } from "./entities/training-point-recalculation-task.entity";
import { UserProblemPointEntity } from "./entities/user-problem-point.entity";
import { TrainingPointService } from "./training-point.service";

@Module({
  imports: [
    TypeOrmModule.forFeature([UserProblemPointEntity, TrainingPointLedgerEntity, TrainingPointRecalculationTaskEntity]),
    RedisModule
  ],
  providers: [TrainingPointService],
  exports: [TrainingPointService]
})
export class TrainingPointModule {}
