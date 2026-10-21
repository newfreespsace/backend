import { Injectable, OnModuleInit } from "@nestjs/common";

import Redis from "ioredis";

import { ConfigService } from "@/config/config.service";

const REDIS_CACHE_EXPIRE_TIME = 60 * 60 * 24 * 30; // 7 days

@Injectable()
export class RedisService implements OnModuleInit {
  private readonly client: Redis;

  private readonly untilReady: Promise<void>;

  constructor(private readonly configService: ConfigService) {
    this.client = new Redis(this.configService.config.services.redis, {
      enableReadyCheck: true
    });

    // TODO: Handle errors after connected?
    this.untilReady = new Promise((resolve, reject) => {
      this.client.once("ready", resolve);
      this.client.once("error", reject);
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.untilReady;
    } catch (e) {
      throw new Error(`Could not connect to Redis service: ${e}`);
    }
  }

  async cacheSet(key: string, value: string): Promise<void> {
    await this.client.setex(key, REDIS_CACHE_EXPIRE_TIME, value);
  }

  async cacheGet(key: string): Promise<string> {
    return await this.client.get(key);
  }

  async cacheDelete(key: string): Promise<void> {
    await this.client.del(key);
  }

  /**
   * Reuse the service connection for ordinary, nonblocking Redis commands.
   * Do not use this connection for subscriptions, blocking commands or connection state changes.
   */
  getSharedClient(): Redis {
    return this.client;
  }

  /**
   * Create an independent connection for subscriptions, blocking consumers or custom commands.
   * Allocate once per owning service, never per request or sync turn.
   *
   * Please use `cacheGet` and `cacheSet` for caching since they handle the expire time automatically.
   */
  getClient(): Redis {
    return this.client.duplicate();
  }
}
