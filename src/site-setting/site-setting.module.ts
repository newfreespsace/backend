import { Module, forwardRef } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { ConfigModule } from "@/config/config.module";

import { SiteSettingController } from "./site-setting.controller";
import { SiteSettingEntity } from "./site-setting.entity";
import { SiteSettingService } from "./site-setting.service";

@Module({
  imports: [TypeOrmModule.forFeature([SiteSettingEntity]), forwardRef(() => ConfigModule)],
  controllers: [SiteSettingController],
  providers: [SiteSettingService],
  exports: [SiteSettingService]
})
export class SiteSettingModule {}
