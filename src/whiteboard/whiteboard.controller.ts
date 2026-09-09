import { Body, Controller, ForbiddenException, Post } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import { CurrentUser } from "@/common/user.decorator";
import { UserEntity } from "@/user/user.entity";

import { SaveWhiteboardDto, WhiteboardIdDto, WhiteboardVersionDto } from "./whiteboard.dto";
import { WhiteboardService } from "./whiteboard.service";

@ApiTags("Whiteboard")
@ApiBearerAuth()
@Controller("whiteboard")
export class WhiteboardController {
  constructor(private readonly service: WhiteboardService) {}

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
