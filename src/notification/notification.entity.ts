import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from "typeorm";

import { UserEntity } from "@/user/user.entity";

@Entity("notification")
export class NotificationEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ length: 64 })
  requestHash: string;

  // Retain the legacy column so existing databases keep their historical data.
  // New notifications use only body; the column is neither selected nor exposed.
  @Column({ length: 120, default: "", select: false })
  title: string;

  @Column({ type: "text" })
  body: string;

  @Column({ length: 500, default: "" })
  targetPath: string;

  @Column()
  senderId: number;

  @Column({ length: 16 })
  audience: string;

  @Column({ length: 1000 })
  audienceLabel: string;

  @Column()
  recipientCount: number;

  @Column({ default: false })
  push: boolean;

  @CreateDateColumn()
  createdAt: Date;
}

@Entity("notification_recipient")
@Index(["notificationId", "userId"], { unique: true })
@Index(["userId", "readAt", "id"])
@Index(["userId", "id"])
export class NotificationRecipientEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column()
  userId: number;

  @ManyToOne(() => UserEntity, { onDelete: "CASCADE" })
  @JoinColumn({ name: "userId" })
  user: Promise<UserEntity>;

  @Column({ type: "varchar", length: 36 })
  notificationId: string;

  @ManyToOne(() => NotificationEntity, { onDelete: "CASCADE" })
  @JoinColumn({ name: "notificationId" })
  notification: NotificationEntity;

  @Column({ type: "datetime", nullable: true })
  readAt: Date | null;
}

@Entity("notification_push_subscription")
@Index(["userId", "enabled"])
export class PushSubscriptionEntity {
  @PrimaryGeneratedColumn("uuid")
  id: string;

  @Column({ length: 64, unique: true })
  endpointHash: string;

  @Column({ type: "text" })
  endpoint: string;

  @Column({ length: 120 })
  p256dh: string;

  @Column({ length: 32 })
  auth: string;

  @Column()
  userId: number;

  @ManyToOne(() => UserEntity, { onDelete: "CASCADE" })
  @JoinColumn({ name: "userId" })
  user: Promise<UserEntity>;

  @Column()
  sessionId: number;

  @Column({ type: "datetime" })
  expiresAt: Date;

  @Column({ length: 36 })
  bindingVersion: string;

  @Column({ default: true })
  enabled: boolean;

  @CreateDateColumn()
  createdAt: Date;
}

@Entity("notification_push_job")
@Index(["notificationId", "subscriptionId"], { unique: true })
@Index(["status", "availableAt"])
export class NotificationPushJobEntity {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: "varchar", length: 36 })
  notificationId: string;

  @ManyToOne(() => NotificationEntity, { onDelete: "CASCADE" })
  @JoinColumn({ name: "notificationId" })
  notification: Promise<NotificationEntity>;

  @Column({ length: 36 })
  subscriptionId: string;

  @Column({ length: 36 })
  bindingVersion: string;

  @Column()
  userId: number;

  @Column({ length: 16, default: "pending" })
  status: string;

  @Column({ default: 0 })
  attempts: number;

  @Column({ type: "datetime" })
  availableAt: Date;
}
