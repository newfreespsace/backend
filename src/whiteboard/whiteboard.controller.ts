import { Body, Controller, ForbiddenException, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "@/common/user.decorator";
import { UserEntity } from "@/user/user.entity";

import { SaveLibraryDto, SaveWhiteboardDto, WhiteboardIdDto, WhiteboardVersionDto } from "./whiteboard.dto";
import { WhiteboardService } from "./whiteboard.service";
import { WhiteboardLibraryService } from "./library.service";

@ApiTags("Whiteboard")
@ApiBearerAuth()
@Controller("whiteboard")
export class WhiteboardController {
  constructor(private readonly service: WhiteboardService, private readonly library: WhiteboardLibraryService) {}

  @Post("library/get")
  getLibrary(@CurrentUser() user: UserEntity) {
    return this.library.get(this.userId(user));
  }

  @Post("library/save")
  saveLibrary(@CurrentUser() user: UserEntity, @Body() request: SaveLibraryDto) {
    return this.library.save(this.userId(user), request.changes);
  }

  private userId(user: UserEntity): number {
    if (!user) throw new ForbiddenException("permission denied");
    return user.id;
  }

  @Post("list")
  list(@CurrentUser() user: UserEntity) {
    return this.service.list(this.userId(user));
  }

  @Post("get")
  get(@CurrentUser() user: UserEntity, @Body() request: WhiteboardIdDto) {
    return this.service.get(this.userId(user), request.id);
  }

  @Post("save")
  save(@CurrentUser() user: UserEntity, @Body() request: SaveWhiteboardDto) {
    return this.service.save(this.userId(user), request);
  }

  @Post("delete")
  delete(@CurrentUser() user: UserEntity, @Body() request: WhiteboardVersionDto) {
    return this.service.delete(this.userId(user), request);
  }
}
