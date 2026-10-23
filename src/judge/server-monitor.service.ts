import { createHash, randomBytes } from "crypto";
import os from "os";

import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";

import { RedisService } from "@/redis/redis.service";

import { cpuUsage, readServerResources, ResourceCounters } from "./server-resource-reader";
import { aggregateServerSamples, ServerMonitorSnapshot, ServerResourceSample } from "./server-monitor.types";

const PREFIX = "server-monitor:v1";
const REGISTRY = `${PREFIX}:hosts`;
const RETENTION_MS = 86400000;
// Renew a single sampler per host across all backend processes. A crashed sampler expires automatically.
const CLAIM = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], 25000)
  return 1
end
return redis.call('SET', KEYS[1], ARGV[1], 'PX', 25000, 'NX') and 1 or 0`;
const WRITE = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('ZADD', KEYS[2], ARGV[2], ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', ARGV[4])
redis.call('ZREMRANGEBYRANK', KEYS[2], 0, -8642)
redis.call('PEXPIRE', KEYS[2], 86400000)
redis.call('ZADD', KEYS[3], ARGV[2], ARGV[5])
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', ARGV[4])
redis.call('PEXPIRE', KEYS[3], 86400000)
return 1`;

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Server monitor timeout")), 1500);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

@Injectable()
export class ServerMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly hostId = createHash("sha256").update(os.hostname()).digest("hex").slice(0, 12);

  private readonly token = randomBytes(16).toString("hex");

  private timer: ReturnType<typeof setInterval>;

  private previous: ResourceCounters | null = null;

  private collecting = false;

  private stopped = false;

  private readonly cache = new Map<number, { expires: number; value: Promise<ServerMonitorSnapshot> }>();

  constructor(private readonly redisService: RedisService) {}

  onModuleInit(): void {
    this.collect();
    this.timer = setInterval(() => this.collect(), 10000);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    clearInterval(this.timer);
  }

  private async collect(): Promise<void> {
    if (this.stopped || this.collecting) return;
    const redis = this.redisService.getSharedClient();
    if (redis.status !== "ready") return;
    this.collecting = true;
    const lock = `${PREFIX}:${this.hostId}:lock`;
    try {
      const claimed = await redis.eval(CLAIM, 1, lock, this.token);
      if (!claimed) {
        this.previous = null;
        return;
      }
      const counters = await readServerResources();
      const at = Date.now();
      const sample: ServerResourceSample = {
        at,
        cpuPercent: cpuUsage(this.previous, counters),
        memoryPercent: (counters.memoryUsedBytes / counters.memoryTotalBytes) * 100,
        memoryUsedBytes: counters.memoryUsedBytes,
        memoryTotalBytes: counters.memoryTotalBytes
      };
      this.previous = counters;
      if (this.stopped) return;
      await redis.eval(
        WRITE,
        3,
        lock,
        `${PREFIX}:${this.hostId}:samples`,
        REGISTRY,
        this.token,
        at,
        JSON.stringify(sample),
        at - RETENTION_MS,
        this.hostId
      );
    } catch {
      // Monitoring failures must not interrupt judging or create an unbounded retry queue.
      this.previous = null;
    } finally {
      this.collecting = false;
    }
  }

  getSnapshot(hours: number): Promise<ServerMonitorSnapshot> {
    const cached = this.cache.get(hours);
    if (cached && cached.expires > Date.now()) return cached.value;
    const value = this.readSnapshot(hours);
    this.cache.set(hours, { expires: Date.now() + 10000, value });
    return value;
  }

  private async readSnapshot(hours: number): Promise<ServerMonitorSnapshot> {
    const bucketSeconds = hours === 1 ? 10 : hours === 6 ? 60 : 120;
    try {
      const redis = this.redisService.getSharedClient();
      if (redis.status !== "ready") throw new Error("Redis unavailable");
      const now = Date.now();
      const hosts = await bounded(redis.zrangebyscore(REGISTRY, now - RETENTION_MS, "+inf", "LIMIT", 0, 16));
      const servers = await bounded(
        Promise.all(
          hosts.map(async id => {
            const rows = await redis.zrangebyscore(`${PREFIX}:${id}:samples`, now - hours * 3600000, now);
            const samples: ServerResourceSample[] = rows.map(row => JSON.parse(row));
            if (!samples.length) return null;
            return { id, latest: samples[samples.length - 1], points: aggregateServerSamples(samples, now, hours) };
          })
        )
      );
      return { unavailable: false, bucketSeconds, servers: servers.filter(server => server !== null) };
    } catch {
      return { unavailable: true, bucketSeconds, servers: [] };
    }
  }
}
