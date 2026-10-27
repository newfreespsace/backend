export const NOTIFICATION_CHANNEL = "nsoj:notifications";

export interface NotificationEvent {
  userIds?: number[];
  revoke?: { userId: number; sessionId?: number; exceptSessionId?: number };
}
