import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { WhiteboardEntity } from "./whiteboard.entity";
import { WhiteboardService } from "./whiteboard.service";
import { WhiteboardController } from "./whiteboard.controller";

@Module({
  imports: [TypeOrmModule.forFeature([WhiteboardEntity])],
  controllers: [WhiteboardController],
  providers: [WhiteboardService]
})
export class WhiteboardModule {}
