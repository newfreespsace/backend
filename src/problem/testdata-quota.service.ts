import { Injectable } from "@nestjs/common";

import { ConfigService } from "@/config/config.service";
import { RedisService } from "@/redis/redis.service";

export function localDateKey(date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}${month}${day}`;
}

const CONSUME = `
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
local count = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
if used + count > limit and count > 0 then
  return {0, math.max(0, limit - used)}
end
if count > 0 then
  used = redis.call('INCRBY', KEYS[1], count)
  if used == count then redis.call('EXPIRE', KEYS[1], ARGV[3]) end
end
return {1, math.max(0, limit - used)}
`;

@Injectable()
export class TestdataQuotaService {
  constructor(private readonly config: ConfigService, private readonly redis: RedisService) {}

  async consume(identifier: string, count: number): Promise<{ allowed: boolean; remaining: number }> {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setHours(24, 0, 0, 0);
    const expires = Math.max(1, Math.ceil((+tomorrow - +now) / 1000));
    const key = `problem-testdata-daily-download:${identifier}:${localDateKey(now)}`;
    const [allowed, remaining] = (await this.redis
      .getSharedClient()
      .eval(CONSUME, 1, key, count, this.config.config.resourceLimit.problemTestdataDailyDownloadFiles, expires)) as [
      number,
      number
    ];
    return { allowed: !!allowed, remaining };
  }
}
