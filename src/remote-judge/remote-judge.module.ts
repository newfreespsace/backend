import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { AuditModule } from "@/audit/audit.module";
import { RedisModule } from "@/redis/redis.module";
import { UserModule } from "@/user/user.module";
import { ProblemModule } from "@/problem/problem.module";
import { SubmissionModule } from "@/submission/submission.module";
import { ContestModule } from "@/contest/contest.module";
import { ConfigModule } from "@/config/config.module";
import { SiteSettingModule } from "@/site-setting/site-setting.module";

import { RemoteAccountEntity } from "./remote-account.entity";
import { RemoteWatchEntity } from "./remote-watch.entity";
import { RemoteProviderService } from "./remote-provider.service";
import { RemoteJudgeService } from "./remote-judge.service";
import { RemoteJudgeController } from "./remote-judge.controller";
import { CodeforcesCredentialsService } from "./codeforces-credentials.service";
import { CodeforcesImportBufferEntity } from "./codeforces-import-buffer.entity";
import { CodeforcesImportBufferService } from "./codeforces-import-buffer.service";
import { RemoteJudgeMonitorService } from "./remote-judge-monitor.service";
import { AtcoderSourceService } from "./atcoder-source.service";

@Module({
  imports: [
    TypeOrmModule.forFeature([RemoteAccountEntity, RemoteWatchEntity, CodeforcesImportBufferEntity]),
    RedisModule,
    UserModule,
    ProblemModule,
    SubmissionModule,
    ContestModule,
    ConfigModule,
    SiteSettingModule,
    AuditModule
  ],
  providers: [
    RemoteProviderService,
    RemoteJudgeService,
    CodeforcesCredentialsService,
    CodeforcesImportBufferService,
    RemoteJudgeMonitorService,
    AtcoderSourceService
  ],
  controllers: [RemoteJudgeController]
})
export class RemoteJudgeModule {}
