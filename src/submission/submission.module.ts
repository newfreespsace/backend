import { Module, forwardRef } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { RedisModule } from "@/redis/redis.module";
import { ProblemModule } from "@/problem/problem.module";
import { ProblemTypeModule } from "@/problem-type/problem-type.module";
import { JudgeModule } from "@/judge/judge.module";
import { UserModule } from "@/user/user.module";
import { AuditModule } from "@/audit/audit.module";
import { FileModule } from "@/file/file.module";
import { MetricsModule } from "@/metrics/metrics.module";
import { ContestModule } from "@/contest/contest.module";
import { SiteSettingModule } from "@/site-setting/site-setting.module";
import { ProblemReviewModule } from "@/problem-review/problem-review.module";
import { TrainingPointModule } from "@/training-points/training-point.module";

import { SubmissionEntity } from "./submission.entity";
import { SubmissionDetailEntity } from "./submission-detail.entity";
import { SubmissionService } from "./submission.service";
import { SubmissionController } from "./submission.controller";
import { SubmissionProgressService } from "./submission-progress.service";
import { SubmissionProgressGateway } from "./submission-progress.gateway";
import { SubmissionStatisticsService } from "./submission-statistics.service";

@Module({
  imports: [
    TypeOrmModule.forFeature([SubmissionEntity]),
    TypeOrmModule.forFeature([SubmissionDetailEntity]),
    forwardRef(() => RedisModule),
    forwardRef(() => ProblemModule),
    forwardRef(() => ProblemTypeModule),
    forwardRef(() => JudgeModule),
    forwardRef(() => UserModule),
    forwardRef(() => AuditModule),
    forwardRef(() => FileModule),
    forwardRef(() => ContestModule),
    forwardRef(() => MetricsModule),
    forwardRef(() => SiteSettingModule),
    forwardRef(() => ProblemReviewModule),
    TrainingPointModule
  ],
  providers: [SubmissionService, SubmissionProgressService, SubmissionProgressGateway, SubmissionStatisticsService],
  controllers: [SubmissionController],
  exports: [SubmissionService]
})
export class SubmissionModule {}
