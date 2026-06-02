import { Module, forwardRef } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { DiscussionModule } from "@/discussion/discussion.module";
import { ProblemModule } from "@/problem/problem.module";
import { SubmissionModule } from "@/submission/submission.module";
import { UserModule } from "@/user/user.module";

import { ContestController } from "./contest.controller";
import { ContestEntity } from "./contest.entity";
import { ContestPlayerEntity } from "./contest-player.entity";
import { ContestService } from "./contest.service";

@Module({
  imports: [
    TypeOrmModule.forFeature([ContestEntity]),
    TypeOrmModule.forFeature([ContestPlayerEntity]),
    forwardRef(() => DiscussionModule),
    forwardRef(() => ProblemModule),
    forwardRef(() => SubmissionModule),
    forwardRef(() => UserModule)
  ],
  providers: [ContestService],
  controllers: [ContestController],
  exports: [ContestService]
})
export class ContestModule {}
