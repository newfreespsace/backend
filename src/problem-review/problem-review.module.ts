import { forwardRef, Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { ContestModule } from "@/contest/contest.module";
import { ProblemModule } from "@/problem/problem.module";
import { SubmissionEntity } from "@/submission/submission.entity";

import { ProblemReviewController } from "./problem-review.controller";
import { ProblemReviewEntity } from "./problem-review.entity";
import { ProblemReviewService } from "./problem-review.service";

@Module({
  imports: [
    TypeOrmModule.forFeature([ProblemReviewEntity, SubmissionEntity]),
    forwardRef(() => ContestModule),
    forwardRef(() => ProblemModule)
  ],
  controllers: [ProblemReviewController],
  providers: [ProblemReviewService],
  exports: [ProblemReviewService]
})
export class ProblemReviewModule {}
