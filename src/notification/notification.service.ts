import { createHash, randomUUID } from "crypto";

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";

import { DataSource, In, IsNull, MoreThan, Repository } from "typeorm";

import { UserEntity } from "@/user/user.entity";
import { GroupEntity } from "@/group/group.entity";
import { GroupMembershipEntity } from "@/group/group-membership.entity";
import { RedisService } from "@/redis/redis.service";

import {
  NotificationEntity,
  NotificationPushJobEntity,
  NotificationRecipientEntity,
  PushSubscriptionEntity
} from "./notification.entity";
import { BindPushDto, QueryNotificationsDto, SendNotificationDto } from "./notification.dto";
import { validateNotificationPath, validatePushEndpoint, validatePushKeys } from "./notification-security";
import { NotificationPushService } from "./notification-push.service";

import { NOTIFICATION_CHANNEL } from "./notification.events";

@Injectable()
export class NotificationService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(NotificationEntity) private readonly notifications: Repository<NotificationEntity>,
    @InjectRepository(NotificationRecipientEntity) private readonly recipients: Repository<NotificationRecipientEntity>,
    @InjectRepository(PushSubscriptionEntity) private readonly subscriptions: Repository<PushSubscriptionEntity>,
    private readonly redisService: RedisService,
    private readonly pushService: NotificationPushService
  ) {}

  async changed(userIds: number[]): Promise<void> {
    // The database is authoritative. A missed hint is recovered on reconnect/focus.
    for (let i = 0; i < userIds.length; i += 500) {
      // eslint-disable-next-line no-await-in-loop
      await this.redisService
        .getSharedClient()
        .publish(NOTIFICATION_CHANNEL, JSON.stringify({ userIds: userIds.slice(i, i + 500) }))
        .catch(() => undefined);
    }
  }

  async unreadCount(userId: number) {
    return {
      count: await this.recipients.countBy({
        userId,
        readAt: IsNull(),
        deletedAt: IsNull(),
        notification: { revokedAt: IsNull() }
      })
    };
  }

  async query(userId: number, query: QueryNotificationsDto) {
    const [rows, total] = await this.recipients.findAndCount({
      where: {
        userId,
        deletedAt: IsNull(),
        notification: { revokedAt: IsNull() },
        ...(query.unreadOnly ? { readAt: IsNull() } : {})
      },
      relations: { notification: true },
      order: { id: "DESC" },
      skip: query.skip,
      take: query.take
    });
    return {
      items: rows.map(row => ({
        id: row.notificationId,
        body: row.notification.body,
        targetPath: row.notification.targetPath,
        createdAt: row.notification.createdAt,
        readAt: row.readAt
      })),
      total
    };
  }

  async get(userId: number, id: string) {
    const row = await this.recipients.findOne({
      where: { userId, notificationId: id, deletedAt: IsNull(), notification: { revokedAt: IsNull() } },
      relations: { notification: true }
    });
    if (!row) throw new NotFoundException();
    return {
      item: {
        id: row.notificationId,
        body: row.notification.body,
        targetPath: row.notification.targetPath,
        createdAt: row.notification.createdAt,
        readAt: row.readAt
      }
    };
  }

  async markRead(userId: number, id?: string, all = false) {
    if (!all && !id) throw new BadRequestException("Specify a notification or all");
    await this.recipients.update(
      { userId, deletedAt: IsNull(), readAt: IsNull(), ...(!all ? { notificationId: id } : {}) },
      { readAt: new Date() }
    );
    await this.changed([userId]);
    return await this.unreadCount(userId);
  }

  async deleteReceived(userId: number, id: string) {
    await this.dataSource.transaction(async manager => {
      const recipients = manager.getRepository(NotificationRecipientEntity);
      const recipient = await recipients.findOneBy({ userId, notificationId: id });
      if (!recipient) throw new NotFoundException();
      await recipients.update({ userId, notificationId: id, deletedAt: IsNull() }, { deletedAt: new Date() });
      await manager
        .getRepository(NotificationPushJobEntity)
        .update({ userId, notificationId: id, status: In(["pending", "processing"]) }, { status: "cancelled" });
    });
    await this.changed([userId]);
    return await this.unreadCount(userId);
  }

  async revoke(admin: UserEntity, id: string) {
    if (!admin?.isAdmin || !admin.isActive) throw new ForbiddenException();
    const userIds = await this.dataSource.transaction(async manager => {
      const notifications = manager.getRepository(NotificationEntity);
      const notification = await notifications.findOneBy({ id });
      if (!notification) throw new NotFoundException();
      const now = new Date();
      // Keep the first revocation and the idempotency record, including on retries.
      await notifications.update({ id, revokedAt: IsNull() }, { revokedAt: now, revokedById: admin.id });
      const recipients = manager.getRepository(NotificationRecipientEntity);
      const affected = await recipients.find({
        where: { notificationId: id, deletedAt: IsNull() },
        select: { userId: true }
      });
      await recipients.update({ notificationId: id, deletedAt: IsNull() }, { deletedAt: now });
      await manager
        .getRepository(NotificationPushJobEntity)
        .update({ notificationId: id, status: In(["pending", "processing"]) }, { status: "cancelled" });
      return [...new Set([admin.id, ...affected.map(recipient => recipient.userId)])];
    });
    await this.changed(userIds);
    return { success: true };
  }

  async send(sender: UserEntity, request: SendNotificationDto) {
    if (!sender?.isAdmin) throw new ForbiddenException();
    const body = request.body.trim();
    if (!body) throw new BadRequestException("Notification content is required");
    validateNotificationPath(request.targetPath);
    if (request.push && !this.pushService.enabled) throw new BadRequestException("Browser push is not configured");
    const requestHash = createHash("sha256")
      .update(
        JSON.stringify({
          senderId: sender.id,
          body,
          targetPath: request.targetPath,
          audience: request.audience,
          usernames: [...request.usernames].sort(),
          groupId: request.groupId,
          // Omit empty groupIds to preserve hashes from older single-group clients.
          ...(request.groupIds?.length ? { groupIds: [...request.groupIds].sort((a, b) => a - b) } : {}),
          push: request.push
        })
      )
      .digest("hex");
    const existing = await this.notifications.findOneBy({ id: request.requestId });
    if (existing) {
      if (existing.senderId !== sender.id || existing.requestHash !== requestHash)
        throw new ConflictException("Request ID already used");
      return { id: existing.id, recipientCount: existing.recipientCount };
    }
    let userIds: number[] = [];
    let result: NotificationEntity;
    try {
      result = await this.dataSource.transaction(async manager => {
        const users = manager
          .getRepository(UserEntity)
          .createQueryBuilder("user")
          .select("user.id", "id")
          .where("user.isActive = :active", { active: true });
        let audienceLabel = "全站用户";
        if (request.audience === "users") {
          if (!request.usernames.length) throw new BadRequestException("Choose recipients");
          users.andWhere("user.username IN (:...usernames)", { usernames: request.usernames });
          audienceLabel = request.usernames.join(", ").slice(0, 1000);
        } else if (request.audience === "group") {
          const groupIds = [...new Set([...(request.groupIds || []), ...(request.groupId ? [request.groupId] : [])])];
          if (!groupIds.length || groupIds.length > 500)
            throw new BadRequestException("Choose between 1 and 500 recipient groups");
          const groups = await manager.getRepository(GroupEntity).findBy({ id: In(groupIds) });
          if (groups.length !== groupIds.length) throw new BadRequestException("Group does not exist");
          users
            .innerJoin(
              GroupMembershipEntity,
              "membership",
              "membership.userId = user.id AND membership.groupId IN (:...groupIds)",
              { groupIds }
            )
            .distinct(true);
          const names = new Map(groups.map(group => [group.id, group.name || `群组 #${group.id}`]));
          audienceLabel = groupIds
            .map(id => names.get(id))
            .join(", ")
            .slice(0, 1000);
        }
        const selected = await users.getRawMany<{ id: number }>();
        userIds = [...new Set(selected.map(row => Number(row.id)))];
        if (!userIds.length || (request.audience === "users" && userIds.length !== request.usernames.length))
          throw new BadRequestException("Recipient does not exist or is inactive");
        const notification = manager.getRepository(NotificationEntity).create({
          id: request.requestId,
          requestHash,
          senderId: sender.id,
          body,
          targetPath: request.targetPath,
          audience: request.audience,
          audienceLabel,
          recipientCount: userIds.length,
          push: request.push,
          createdAt: new Date()
        });
        await manager.getRepository(NotificationEntity).insert(notification);
        for (let i = 0; i < userIds.length; i += 500) {
          const batch = userIds.slice(i, i + 500);
          // eslint-disable-next-line no-await-in-loop
          await manager
            .getRepository(NotificationRecipientEntity)
            .insert(batch.map(userId => ({ notificationId: notification.id, userId, readAt: null })));
          if (request.push) {
            // Snapshot subscriptions, so enabling push later never sends old notifications.
            // eslint-disable-next-line no-await-in-loop
            const subscriptions = await manager
              .getRepository(PushSubscriptionEntity)
              .findBy({ userId: In(batch), enabled: true, expiresAt: MoreThan(new Date()) });
            for (let j = 0; j < subscriptions.length; j += 500) {
              // eslint-disable-next-line no-await-in-loop
              await manager.getRepository(NotificationPushJobEntity).insert(
                subscriptions.slice(j, j + 500).map(subscription => ({
                  notificationId: notification.id,
                  subscriptionId: subscription.id,
                  userId: subscription.userId,
                  bindingVersion: subscription.bindingVersion,
                  availableAt: new Date(),
                  status: "pending",
                  attempts: 0
                }))
              );
            }
          }
        }
        return notification;
      });
    } catch (error) {
      // A concurrent retry may have committed the same idempotency key.
      const committed = await this.notifications.findOneBy({ id: request.requestId });
      if (!committed || committed.senderId !== sender.id || committed.requestHash !== requestHash) throw error;
      return { id: committed.id, recipientCount: committed.recipientCount };
    }
    await this.changed(userIds);
    return { id: result.id, recipientCount: result.recipientCount };
  }

  async history(query: QueryNotificationsDto) {
    const [items, total] = await this.notifications.findAndCount({
      order: { createdAt: "DESC", id: "DESC" },
      skip: query.skip,
      take: query.take
    });
    return {
      items: items.map(item => ({
        id: item.id,
        body: item.body,
        targetPath: item.targetPath,
        senderId: item.senderId,
        audience: item.audience,
        audienceLabel: item.audienceLabel,
        recipientCount: item.recipientCount,
        push: item.push,
        createdAt: item.createdAt,
        revokedAt: item.revokedAt,
        revokedById: item.revokedById
      })),
      total
    };
  }

  async bindPush(userId: number, sessionId: number, expiresAt: Date, request: BindPushDto) {
    if (!this.pushService.enabled) throw new BadRequestException("Browser push is not configured");
    if (!Number.isFinite(+expiresAt) || +expiresAt <= Date.now()) throw new ForbiddenException();
    validatePushEndpoint(request.endpoint);
    validatePushKeys(request.keys);
    const endpointHash = createHash("sha256").update(request.endpoint).digest("hex");
    return await this.dataSource.transaction(async manager => {
      const repository = manager.getRepository(PushSubscriptionEntity);
      const existing = await repository.findOne({ where: { endpointHash }, lock: { mode: "pessimistic_write" } });
      // Never transfer an existing browser subscription between accounts. The
      // browser must unsubscribe and generate a new subscription first.
      if (existing && existing.userId !== userId) throw new ConflictException("Recreate this browser subscription");
      if (!existing && (await repository.countBy({ userId, enabled: true, expiresAt: MoreThan(new Date()) })) >= 20)
        throw new BadRequestException("Too many subscribed browsers");
      const sameBinding =
        existing?.enabled &&
        existing.sessionId === sessionId &&
        existing.p256dh === request.keys.p256dh &&
        existing.auth === request.keys.auth;
      const saved = await repository.save({
        ...existing,
        endpointHash,
        endpoint: request.endpoint,
        p256dh: request.keys.p256dh,
        auth: request.keys.auth,
        userId,
        sessionId,
        expiresAt,
        enabled: true,
        bindingVersion: sameBinding ? existing.bindingVersion : randomUUID()
      });
      return { id: saved.id, bindingVersion: saved.bindingVersion, userId };
    });
  }

  async disablePush(userId: number, id: string) {
    await this.subscriptions.update({ id, userId }, { enabled: false, bindingVersion: randomUUID() });
    return { success: true };
  }

  async pushStatus(userId: number) {
    const subscriptions = await this.subscriptions.find({
      where: { userId, enabled: true, expiresAt: MoreThan(new Date()) },
      select: { id: true, bindingVersion: true, sessionId: true }
    });
    return { enabled: this.pushService.enabled, publicKey: this.pushService.publicKey, subscriptions };
  }
}
