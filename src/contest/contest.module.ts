import { Module, forwardRef } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { ProblemModule } from "@/problem/problem.module";
import { UserModule } from "@/user/user.module";

import { ContestController } from "./contest.controller";
import { ContestEntity } from "./contest.entity";
import { ContestPlayerEntity } from "./contest-player.entity";
import { ContestService } from "./contest.service";

@Module({
  imports: [
    TypeOrmModule.forFeature([ContestEntity]),
    TypeOrmModule.forFeature([ContestPlayerEntity]),
    forwardRef(() => ProblemModule),
    forwardRef(() => UserModule)
  ],
  providers: [ContestService],
  controllers: [ContestController],
  exports: [ContestService]
})
export class ContestModule {}
