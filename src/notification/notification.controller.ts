import { Body, Controller, ForbiddenException, Get, Post, Req } from "@nestjs/common";
import { ApiBearerAuth, ApiTags } from "@nestjs/swagger";

import jwt from "jsonwebtoken";

import { CurrentUser } from "@/common/user.decorator";
import { RequestWithSession } from "@/auth/auth.middleware";
import { UserEntity } from "@/user/user.entity";

import { NotificationService } from "./notification.service";
import {
  BindPushDto,
  DisablePushDto,
  QueryNotificationsDto,
  ReadNotificationDto,
  SendNotificationDto
} from "./notification.dto";

@ApiTags("Notifications")
@ApiBearerAuth()
@Controller("notification")
export class NotificationController {
  constructor(private readonly service: NotificationService) {}

  private user(user: UserEntity): UserEntity {
    if (!user?.isActive) throw new ForbiddenException();
    return user;
  }

  @Get("unreadCount")
  unreadCount(@CurrentUser() user: UserEntity) {
    return this.service.unreadCount(this.user(user).id);
  }

  @Post("query")
  query(@CurrentUser() user: UserEntity, @Body() request: QueryNotificationsDto) {
    return this.service.query(this.user(user).id, request);
  }

  @Post("get")
  get(@CurrentUser() user: UserEntity, @Body() request: DisablePushDto) {
    return this.service.get(this.user(user).id, request.id);
  }

  @Post("read")
  read(@CurrentUser() user: UserEntity, @Body() request: ReadNotificationDto) {
    return this.service.markRead(this.user(user).id, request.id, request.all);
  }

  @Post("send")
  send(@CurrentUser() user: UserEntity, @Body() request: SendNotificationDto) {
    return this.service.send(this.user(user), request);
  }

  @Post("history")
  history(@CurrentUser() user: UserEntity, @Body() request: QueryNotificationsDto) {
    if (!this.user(user).isAdmin) throw new ForbiddenException();
    return this.service.history(request);
  }

  @Get("pushStatus")
  pushStatus(@CurrentUser() user: UserEntity) {
    return this.service.pushStatus(this.user(user).id);
  }

  @Post("bindPush")
  bindPush(@CurrentUser() user: UserEntity, @Req() req: RequestWithSession, @Body() request: BindPushDto) {
    const payload = jwt.decode(req.session.sessionKey) as jwt.JwtPayload;
    return this.service.bindPush(
      this.user(user).id,
      req.session.sessionId,
      new Date(Number(payload?.exp) * 1000),
      request
    );
  }

  @Post("disablePush")
  disablePush(@CurrentUser() user: UserEntity, @Body() request: DisablePushDto) {
    return this.service.disablePush(this.user(user).id, request.id);
  }
}
