import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { UserModule } from "@/user/user.module";

import { UsacoGuideController } from "./usaco-guide.controller";
import { UsacoGuideService } from "./usaco-guide.service";
import { UsacoGuideUserDataEntity } from "./usaco-guide-user-data.entity";

@Module({
  imports: [TypeOrmModule.forFeature([UsacoGuideUserDataEntity]), UserModule],
  controllers: [UsacoGuideController],
  providers: [UsacoGuideService]
})
export class UsacoGuideModule {}
