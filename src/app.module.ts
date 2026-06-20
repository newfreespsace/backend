import { Module, forwardRef, NestModule, MiddlewareConsumer, RequestMethod } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";

import { AppController } from "./app.controller";
import { AppService } from "./app.service";
import { ErrorFilter } from "./error.filter";
import { RecaptchaFilter } from "./recaptcha.filter";
import { AuthMiddleware } from "./auth/auth.middleware";
import { AuthRequiredMiddleware } from "./auth/auth-required.middleware";
import { MetricsMiddleware } from "./metrics/metrics.middleware";

import { SharedModule } from "./shared.module";
import { RedisModule } from "./redis/redis.module";
import { DatabaseModule } from "./database/database.module";
import { UserModule } from "./user/user.module";
import { AuthModule } from "./auth/auth.module";
import { CorsModule } from "./cors/cors.module";
import { GroupModule } from "./group/group.module";
import { ProblemModule } from "./problem/problem.module";
import { ProblemTypeModule } from "./problem-type/problem-type.module";
import { LocalizedContentModule } from "./localized-content/localized-content.module";
import { PermissionModule } from "./permission/permission.module";
import { FileModule } from "./file/file.module";
import { SubmissionModule } from "./submission/submission.module";
import { JudgeModule } from "./judge/judge.module";
import { DiscussionModule } from "./discussion/discussion.module";
import { MigrationModule } from "./migration/migration.module";
import { EventReportModule } from "./event-report/event-report.module";
import { HomepageModule } from "./homepage/homepage.module";
import { MetricsModule } from "./metrics/metrics.module";
import { ContestModule } from "./contest/contest.module";
import { SiteSettingModule } from "./site-setting/site-setting.module";
import { GalleryModule } from "./gallery/gallery.module";

import { RequestLogMiddleware } from "./request-log.middleware";
import { TrainingModule } from "./training/training.module";
import { ContestAccessGuard } from "./contest/contest-access.guard";

@Module({
  imports: [
    SharedModule,
    forwardRef(() => DatabaseModule),
    forwardRef(() => RedisModule),
    forwardRef(() => UserModule),
    forwardRef(() => AuthModule),
    forwardRef(() => CorsModule),
    forwardRef(() => GroupModule),
    forwardRef(() => ProblemModule),
    forwardRef(() => ProblemTypeModule),
    forwardRef(() => LocalizedContentModule),
    forwardRef(() => PermissionModule),
    forwardRef(() => FileModule),
    forwardRef(() => SubmissionModule),
    forwardRef(() => JudgeModule),
    forwardRef(() => DiscussionModule),
    forwardRef(() => ContestModule),
    forwardRef(() => EventReportModule),
    forwardRef(() => HomepageModule),
    forwardRef(() => MigrationModule),
    forwardRef(() => MetricsModule),
    forwardRef(() => SiteSettingModule),
    forwardRef(() => GalleryModule),
    TrainingModule
  ],
  controllers: [AppController],
  providers: [
    AppService,
    ErrorFilter,
    RecaptchaFilter,
    {
      provide: APP_GUARD,
      useClass: ContestAccessGuard
    }
  ]
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(AuthMiddleware).forRoutes({
      path: "*",
      method: RequestMethod.ALL
    });
    consumer.apply(AuthRequiredMiddleware).forRoutes({
      path: "*",
      method: RequestMethod.ALL
    });
    consumer.apply(MetricsMiddleware).forRoutes({
      path: "*",
      method: RequestMethod.ALL
    });
    consumer.apply(RequestLogMiddleware).forRoutes({
      path: "*",
      method: RequestMethod.ALL
    });
  }
}
