import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";

import { IsNull, MoreThan, Repository } from "typeorm";
import webPush from "web-push";

import { AuthSessionService } from "@/auth/auth-session.service";
import { UserEntity } from "@/user/user.entity";

import { NotificationPushJobEntity, NotificationRecipientEntity, PushSubscriptionEntity } from "./notification.entity";
import { validatePushEndpoint } from "./notification-security";

@Injectable()
export class NotificationPushService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("NotificationPush");

  readonly publicKey = process.env.NSOJ_PUSH_PUBLIC_KEY || "";

  private readonly privateKey = process.env.NSOJ_PUSH_PRIVATE_KEY || "";

  private readonly subject = process.env.NSOJ_PUSH_SUBJECT || "";

  readonly enabled = !!(this.publicKey && this.privateKey && this.subject);

  private timer: ReturnType<typeof setInterval>;

  private running = false;

  constructor(
    @InjectRepository(NotificationPushJobEntity) private readonly jobs: Repository<NotificationPushJobEntity>,
    @InjectRepository(PushSubscriptionEntity) private readonly subscriptions: Repository<PushSubscriptionEntity>,
    @InjectRepository(NotificationRecipientEntity) private readonly recipients: Repository<NotificationRecipientEntity>,
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    private readonly sessions: AuthSessionService
  ) {}

  onModuleInit() {
    if (!this.enabled) return;
    // Fail early for malformed VAPID settings, rather than silently losing pushes.
    webPush.setVapidDetails(this.subject, this.publicKey, this.privateKey);
    this.timer = setInterval(() => {
      this.drain().catch(() => this.logger.error("Push queue processing failed"));
    }, 5000);
    this.timer.unref();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const candidates = await this.jobs
        .createQueryBuilder("job")
        .where("job.status IN (:...states) AND job.availableAt <= :now", {
          states: ["pending", "processing"],
          now: new Date()
        })
        .orderBy("job.id", "ASC")
        .take(20)
        .getMany();
      for (let i = 0; i < candidates.length; i += 4) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.all(candidates.slice(i, i + 4).map(job => this.deliver(job)));
      }
    } finally {
      this.running = false;
    }
  }

  async deliver(job: NotificationPushJobEntity): Promise<void> {
    // Optimistic claim also recovers jobs abandoned by a crashed process.
    const claim = await this.jobs.update(
      { id: job.id, status: job.status, attempts: job.attempts, availableAt: job.availableAt },
      { status: "processing", attempts: job.attempts + 1, availableAt: new Date(Date.now() + 120000) }
    );
    if (!claim.affected) return;
    let status = "cancelled";
    try {
      if (job.attempts >= 5) {
        status = "failed";
        return;
      }
      const subscription = await this.subscriptions.findOneBy({
        id: job.subscriptionId,
        userId: job.userId,
        bindingVersion: job.bindingVersion,
        enabled: true,
        expiresAt: MoreThan(new Date())
      });
      if (
        !subscription ||
        !(await this.sessions.isSessionActive(job.userId, subscription.sessionId)) ||
        !(await this.users.countBy({ id: job.userId, isActive: true })) ||
        !(await this.recipients.countBy({ notificationId: job.notificationId, userId: job.userId, readAt: IsNull() }))
      )
        return;
      validatePushEndpoint(subscription.endpoint);
      // All payloads are generic. The private content is fetched only by an
      // authenticated recipient after opening the notification center.
      await webPush.sendNotification(
        { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
        JSON.stringify({ userId: job.userId, bindingVersion: job.bindingVersion, notificationId: job.notificationId }),
        {
          TTL: 300,
          timeout: 10000,
          urgency: "normal",
          ...(new URL(subscription.endpoint).hostname.endsWith(".notify.windows.com")
            ? { headers: { "X-WNS-Type": "wns/raw" } }
            : {}),
          vapidDetails: { subject: this.subject, publicKey: this.publicKey, privateKey: this.privateKey }
        }
      );
      status = "sent";
    } catch (error) {
      const { statusCode } = error as { statusCode?: number };
      if (statusCode === 404 || statusCode === 410) {
        await this.subscriptions.update(
          { id: job.subscriptionId, bindingVersion: job.bindingVersion },
          { enabled: false }
        );
        status = "expired";
      } else if (!statusCode || statusCode === 429 || statusCode >= 500) {
        status = job.attempts < 4 ? "pending" : "failed";
      } else status = "failed";
      // Never log subscription endpoints, keys or provider response bodies.
      if (status === "failed") this.logger.warn(`Push job ${job.id} failed (${statusCode || "network"})`);
    } finally {
      await this.jobs.update(
        { id: job.id, status: "processing", attempts: job.attempts + 1 },
        { status, availableAt: new Date(Date.now() + Math.min(3600000, 30000 * 2 ** job.attempts)) }
      );
    }
  }
}
