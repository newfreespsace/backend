import { Module, forwardRef } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { FileModule } from "@/file/file.module";
import { RedisModule } from "@/redis/redis.module";

import { GalleryController } from "./gallery.controller";
import { GalleryImageEntity } from "./gallery-image.entity";
import { GalleryService } from "./gallery.service";

@Module({
  imports: [
    TypeOrmModule.forFeature([GalleryImageEntity]),
    forwardRef(() => FileModule),
    forwardRef(() => RedisModule)
  ],
  providers: [GalleryService],
  controllers: [GalleryController]
})
export class GalleryModule {}
