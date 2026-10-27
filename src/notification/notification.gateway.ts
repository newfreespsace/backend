import { OnModuleDestroy } from "@nestjs/common";
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  OnGatewayInit,
  WebSocketGateway,
  WebSocketServer
} from "@nestjs/websockets";

import { Server, Socket } from "socket.io"; // eslint-disable-line import/no-extraneous-dependencies
import SocketIOParser from "socket.io-msgpack-parser";
import jwt from "jsonwebtoken";
import Redis from "ioredis";

import { AuthSessionService } from "@/auth/auth-session.service";
import { RedisService } from "@/redis/redis.service";

import { NOTIFICATION_CHANNEL, NotificationEvent } from "./notification.events";

@WebSocketGateway({
  namespace: "notifications",
  path: "/api/socket",
  transports: ["websocket"],
  parser: SocketIOParser
})
export class NotificationGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
  @WebSocketServer() private server: Server;

  private readonly clients = new Map<
    string,
    { socket: Socket; userId: number; sessionId: number; timer: ReturnType<typeof setTimeout> }
  >();

  private subscriber: Redis;

  constructor(private readonly sessions: AuthSessionService, private readonly redisService: RedisService) {}

  afterInit(server: Server) {
    // Bearer token only: a third-party page cannot open an authenticated socket
    // using the user's automatically attached cookies.
    server.use(async (socket, next) => {
      try {
        const token = socket.handshake.auth?.token;
        if (typeof token !== "string" || token.length > 4096) return next(new Error("login required"));
        const [sessionId, user] = await this.sessions.accessSession(token);
        if (!user) return next(new Error("login required"));
        socket.data.userId = user.id;
        socket.data.sessionId = sessionId;
        const payload = jwt.decode(token) as jwt.JwtPayload;
        socket.data.expiresAt = payload?.exp ? payload.exp * 1000 : Date.now() + 300000;
        return next();
      } catch {
        return next(new Error("login required"));
      }
    });
    this.subscriber = this.redisService.getClient();
    this.subscriber.on("message", (_channel, raw) => {
      try {
        const message = JSON.parse(raw) as NotificationEvent;
        if (message.userIds) for (const userId of message.userIds) server.to(`user:${userId}`).emit("changed");
        if (message.revoke) {
          const { userId, sessionId, exceptSessionId } = message.revoke;
          for (const { socket, userId: owner, sessionId: session } of this.clients.values()) {
            if (owner === userId && (sessionId == null || session === sessionId) && session !== exceptSessionId)
              socket.disconnect();
          }
        }
      } catch {
        /* Ignore malformed internal events. */
      }
    });
    this.subscriber.on("ready", () => {
      server.emit("changed");
    });
    this.subscriber.subscribe(NOTIFICATION_CHANNEL).catch(() => undefined);
  }

  handleConnection(socket: Socket) {
    const { userId, sessionId, expiresAt } = socket.data;
    if (!userId || [...this.clients.values()].filter(client => client.userId === userId).length >= 20) {
      socket.disconnect();
      return;
    }
    // A short connection lease rechecks revocation and account status without
    // querying the database on each heartbeat. Events carry no private content.
    const timer = setTimeout(() => socket.disconnect(), Math.max(1, Math.min(300000, expiresAt - Date.now())));
    timer.unref();
    this.clients.set(socket.id, { socket, userId, sessionId, timer });
    socket.join(`user:${userId}`);
    socket.emit("changed");
  }

  handleDisconnect(socket: Socket) {
    const client = this.clients.get(socket.id);
    if (client) clearTimeout(client.timer);
    this.clients.delete(socket.id);
  }

  async onModuleDestroy() {
    for (const { socket, timer } of this.clients.values()) {
      clearTimeout(timer);
      socket.disconnect();
    }
    if (this.subscriber) this.subscriber.disconnect();
  }
}
