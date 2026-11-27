import { Module } from "@nestjs/common";

import { CodeLanguageModule } from "@/code-language/code-language.module";
import { ContestModule } from "@/contest/contest.module";
import { FileModule } from "@/file/file.module";
import { JudgeModule } from "@/judge/judge.module";
import { ProblemModule } from "@/problem/problem.module";
import { RedisModule } from "@/redis/redis.module";
import { SubmissionModule } from "@/submission/submission.module";

import { HackController } from "./hack.controller";
import { HackService } from "./hack.service";

@Module({
  imports: [CodeLanguageModule, ContestModule, FileModule, JudgeModule, ProblemModule, RedisModule, SubmissionModule],
  controllers: [HackController],
  providers: [HackService]
})
export class HackModule {}
