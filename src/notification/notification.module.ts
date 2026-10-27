import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";

import { AuthModule } from "@/auth/auth.module";
import { RedisModule } from "@/redis/redis.module";
import { UserEntity } from "@/user/user.entity";
import { GroupEntity } from "@/group/group.entity";
import { GroupMembershipEntity } from "@/group/group-membership.entity";

import {
  NotificationEntity,
  NotificationPushJobEntity,
  NotificationRecipientEntity,
  PushSubscriptionEntity
} from "./notification.entity";
import { NotificationService } from "./notification.service";
import { NotificationPushService } from "./notification-push.service";
import { NotificationController } from "./notification.controller";
import { NotificationGateway } from "./notification.gateway";

@Module({
  imports: [
    AuthModule,
    RedisModule,
    TypeOrmModule.forFeature([
      NotificationEntity,
      NotificationRecipientEntity,
      PushSubscriptionEntity,
      NotificationPushJobEntity,
      UserEntity,
      GroupEntity,
      GroupMembershipEntity
    ])
  ],
  controllers: [NotificationController],
  providers: [NotificationService, NotificationPushService, NotificationGateway],
  exports: [NotificationService]
})
export class NotificationModule {}
