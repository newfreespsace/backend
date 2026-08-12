import { join } from "path";
import fs from "fs-extra";

import { Injectable } from "@nestjs/common";

import jwt from "jsonwebtoken";
import { Redis } from "ioredis";
import moment from "moment-timezone";

import { UserEntity } from "@/user/user.entity";
import { ConfigService } from "@/config/config.service";
import { UserService } from "@/user/user.service";
import { RedisService } from "@/redis/redis.service";

// Refer to scripts/session-manager.lua for session management details
interface RedisWithSessionManager extends Redis {
  callSessionManager(...args: (string | number)[]): Promise<unknown>;
}

interface SessionInfoInternal {
  loginIp: string;
  userAgent: string;
  loginTime: number;
  expiresAt: number;
}

interface SessionTokenPayload extends jwt.JwtPayload {
  userId: number;
  sessionId: number;
}

export interface SessionInfo extends SessionInfoInternal {
  sessionId: number;
  lastAccessTime: number;
}

export interface ActiveUserInfo {
  userId: number;
  lastAccessTime: number;
}

@Injectable()
export class AuthSessionService {
  private redis: RedisWithSessionManager;

  constructor(
    private readonly configService: ConfigService,
    private readonly userService: UserService,
    private readonly redisService: RedisService
  ) {
    if (!moment.tz.zone(this.configService.config.security.sessionTimezone))
      throw new Error(`Invalid session timezone: ${this.configService.config.security.sessionTimezone}`);

    this.redis = this.redisService.getClient() as RedisWithSessionManager;
    this.redis.defineCommand("callSessionManager", {
      numberOfKeys: 0,
      lua: fs.readFileSync(join(__dirname, "scripts", "session-manager.lua")).toString("utf-8")
    });
  }

  async newSession(user: UserEntity, loginIp: string, userAgent: string): Promise<string> {
    const now = moment();
    const timeStamp = now.valueOf();
    const expiresAt = now
      .clone()
      .tz(this.configService.config.security.sessionTimezone)
      .add(1, "day")
      .startOf("day")
      .hour(this.configService.config.security.sessionExpirationHour)
      .valueOf();
    const sessionInfo: SessionInfoInternal = {
      loginIp,
      userAgent,
      loginTime: timeStamp,
      expiresAt
    };

    const sessionId = Number(
      await this.redis.callSessionManager("new", timeStamp, expiresAt, user.id, JSON.stringify(sessionInfo))
    );

    return jwt.sign(
      {
        userId: user.id,
        sessionId,
        exp: Math.floor(expiresAt / 1000)
      } as SessionTokenPayload,
      this.configService.config.security.sessionSecret
    );
  }

  private decodeSessionKey(sessionKey: string): [userId: number, sessionId: number] {
    const payload = jwt.verify(sessionKey, this.configService.config.security.sessionSecret);
    const [userId, sessionId] =
      typeof payload === "string"
        ? payload.split(" ").map(value => Number(value))
        : [Number(payload.userId), Number(payload.sessionId)];

    if (!Number.isSafeInteger(userId) || userId <= 0 || !Number.isSafeInteger(sessionId) || sessionId <= 0)
      throw new Error("Invalid session token payload");

    return [userId, sessionId];
  }

  async revokeSession(userId: number, sessionId: number): Promise<void> {
    await this.redis.callSessionManager("revoke", userId, sessionId);
  }

  async revokeAllSessionsExcept(userId: number, sessionId: number): Promise<void> {
    await this.redis.callSessionManager("revoke_all_except", userId, sessionId);
  }

  async endSession(sessionKey: string): Promise<void> {
    try {
      const [userId, sessionId] = this.decodeSessionKey(sessionKey);
      await this.revokeSession(userId, sessionId);
    } catch (e) {
      // Do nothing if we can't decide the session key.
    }
  }

  async accessSession(sessionKey: string): Promise<[sessionId: number, user: UserEntity]> {
    try {
      const [userId, sessionId] = this.decodeSessionKey(sessionKey);

      const success = await this.redis.callSessionManager("access", +new Date(), userId, sessionId);
      if (!success) return [null, null];

      const user = await this.userService.findUserById(userId);
      if (!user?.isActive) {
        await this.revokeSession(userId, sessionId);
        return [null, null];
      }

      return [sessionId, user];
    } catch (e) {
      return [null, null];
    }
  }

  async listUserSessions(userId: number): Promise<SessionInfo[]> {
    const result = (await this.redis.callSessionManager("list", +new Date(), userId)) as [
      sessionId: string,
      lastAccessTime: string,
      sessionInfo: string
    ][];
    return result.map(
      ([sessionId, lastAccessTime, sessionInfo]): SessionInfo => ({
        sessionId: Number(sessionId),
        lastAccessTime: Number(lastAccessTime),
        ...JSON.parse(sessionInfo)
      })
    );
  }

  async listActiveUsers(sinceTime: number, takeCount: number): Promise<ActiveUserInfo[]> {
    const result = (await this.redis.callSessionManager("list_active_users", sinceTime, takeCount)) as string[];

    const activeUsers: ActiveUserInfo[] = [];
    for (let i = 0; i < result.length; i += 2) {
      activeUsers.push({
        userId: Number(result[i]),
        lastAccessTime: Number(result[i + 1])
      });
    }

    return activeUsers;
  }
}
