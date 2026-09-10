import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { WhiteboardEntity } from "./whiteboard.entity";
import { WhiteboardService } from "./whiteboard.service";
import { WhiteboardController } from "./whiteboard.controller";
import { WhiteboardLibraryEntity } from "./library.entity";
import { WhiteboardLibraryService } from "./library.service";

@Module({
  imports: [TypeOrmModule.forFeature([WhiteboardEntity, WhiteboardLibraryEntity])],
  controllers: [WhiteboardController],
  providers: [WhiteboardService, WhiteboardLibraryService]
})
export class WhiteboardModule {}
