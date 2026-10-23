const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
require("reflect-metadata");
require("tsconfig-paths").register({ baseUrl: path.resolve(__dirname, "../dist"), paths: { "@/*": ["*"] } });
const { parseLinuxResources, cpuUsage, readServerResources } = require("../dist/judge/server-resource-reader");
const { aggregateServerSamples } = require("../dist/judge/server-monitor.types");
const { ServerMonitorService } = require("../dist/judge/server-monitor.service");
const { JudgeClientController } = require("../dist/judge/judge-client.controller");
const { ValidationPipe } = require("@nestjs/common");

const sample = (at, cpuPercent = 50, memoryPercent = 40) => ({
  at,
  cpuPercent,
  memoryPercent,
  memoryUsedBytes: 400,
  memoryTotalBytes: 1000
});
test("Linux counters exclude double-counted guests and use available memory", () => {
  const counters = parseLinuxResources(
    "cpu  100 20 30 400 50 6 7 8 90 10\ncpu0 1 2 3 4",
    "MemTotal: 1000 kB\nMemFree: 100 kB\nMemAvailable: 600 kB\n"
  );
  assert.deepEqual(counters, { total: 621, idle: 450, memoryTotalBytes: 1024000, memoryUsedBytes: 409600 });
  assert.equal(cpuUsage(null, counters), null);
  assert.equal(cpuUsage(counters, { ...counters, total: 721, idle: 475 }), 75);
  assert.equal(cpuUsage(counters, counters), null);
  assert.equal(cpuUsage(counters, { ...counters, total: 1, idle: 0 }), null);
  assert.equal(cpuUsage(counters, { ...counters, total: 721, idle: 449 }), null);
  assert.throws(() => parseLinuxResources("cpu invalid", ""));
});
test("native resource reader returns plausible counters", async () => {
  const counters = await readServerResources();
  assert.ok(counters.total > 0);
  assert.ok(counters.idle >= 0 && counters.idle <= counters.total);
  assert.ok(counters.memoryTotalBytes > 0);
  assert.ok(counters.memoryUsedBytes >= 0 && counters.memoryUsedBytes <= counters.memoryTotalBytes);
});
test("aggregation averages known samples, preserves outages and bounds payloads", () => {
  const now = 1800000000000;
  const points = aggregateServerSamples(
    [sample(now - 120000, 20, 30), sample(now - 110000, 80, 50), sample(now, null)],
    now,
    6
  );
  assert.equal(points.length, 361);
  assert.deepEqual(points[points.length - 3], { at: now - 120000, cpuPercent: 50, memoryPercent: 40 });
  assert.deepEqual(points[points.length - 2], { at: now - 60000, cpuPercent: null, memoryPercent: null });
  assert.equal(points.at(-1).cpuPercent, null);
  assert.equal(aggregateServerSamples([], now, 24).length, 721);
  assert.equal(aggregateServerSamples([], now, 1).length, 361);
});
test("resource endpoint validates time ranges and defaults to 24 hours", async () => {
  const Query = Reflect.getMetadata("design:paramtypes", JudgeClientController.prototype, "getServerMonitor")[0];
  const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true });
  const metadata = { type: "query", metatype: Query };
  assert.equal((await pipe.transform({}, metadata)).hours, 24);
  assert.equal((await pipe.transform({ hours: "6" }, metadata)).hours, 6);
  await assert.rejects(pipe.transform({ hours: "2" }, metadata));
  await assert.rejects(pipe.transform({ hours: "NaN" }, metadata));
  await assert.rejects(pipe.transform({ hours: "1", unexpected: "x" }, metadata));
});
test("snapshot reads are cached, use the shared connection and preserve stale timestamps", async () => {
  const latest = sample(Date.now() - 60000);
  let reads = 0;
  const redis = {
    status: "ready",
    zrangebyscore: async key => {
      reads++;
      return key.endsWith(":hosts") ? ["test-host"] : [JSON.stringify(latest)];
    }
  };
  const monitor = new ServerMonitorService({
    getSharedClient: () => redis,
    getClient: () => assert.fail("must reuse shared Redis")
  });
  const first = monitor.getSnapshot(1);
  assert.equal(first, monitor.getSnapshot(1));
  const result = await first;
  assert.equal(result.unavailable, false);
  assert.equal(result.servers[0].latest.at, latest.at);
  assert.equal(reads, 2);
  await monitor.getSnapshot(24);
  assert.equal(reads, 4);
});
test("Redis failures degrade gracefully and do not start extra sampling work", async () => {
  let calls = 0;
  const redis = {
    status: "end",
    eval: async () => {
      calls++;
    }
  };
  const monitor = new ServerMonitorService({ getSharedClient: () => redis });
  assert.deepEqual(await monitor.getSnapshot(1), { unavailable: true, bucketSeconds: 10, servers: [] });
  await monitor.collect();
  assert.equal(calls, 0);
  redis.status = "ready";
  redis.eval = async () => {
    throw new Error("Redis disconnected");
  };
  await monitor.collect();
  assert.equal(monitor.collecting, false);
});
test("concurrent sampling is coalesced and shutdown prevents late writes", async () => {
  let resolveClaim,
    calls = 0;
  const redis = {
    status: "ready",
    eval: () => {
      calls++;
      return new Promise(resolve => {
        resolveClaim = resolve;
      });
    }
  };
  const monitor = new ServerMonitorService({ getSharedClient: () => redis });
  const pending = monitor.collect();
  await monitor.collect();
  assert.equal(calls, 1);
  monitor.onModuleDestroy();
  resolveClaim(1);
  await pending;
  assert.equal(calls, 1);
  await monitor.collect();
  assert.equal(calls, 1);
});

test(
  "real Redis: one sampler per host, lease takeover, retention and read-only history",
  { skip: !process.env.SERVER_MONITOR_TEST_REDIS },
  async t => {
    const Redis = require("ioredis");
    const redis = new Redis(process.env.SERVER_MONITOR_TEST_REDIS);
    const prefix = `server-monitor-test:${process.pid}:${Date.now()}`;
    const mapKey = key => key.replace("server-monitor:v1", prefix);
    const shared = {
      get status() {
        return redis.status;
      },
      eval: (script, count, ...args) =>
        redis.eval(script, count, ...args.map((value, i) => (i < count ? mapKey(value) : value))),
      zrangebyscore: (key, ...args) => redis.zrangebyscore(mapKey(key), ...args)
    };
    t.after(async () => {
      const keys = await redis.keys(`${prefix}:*`);
      if (keys.length) await redis.del(...keys);
      await redis.quit();
    });
    await redis.ping();
    const service = { getSharedClient: () => shared };
    const a = new ServerMonitorService(service),
      b = new ServerMonitorService(service);
    await Promise.all([a.collect(), b.collect()]);
    const samplesKey = `${prefix}:${a.hostId}:samples`,
      lockKey = `${prefix}:${a.hostId}:lock`;
    assert.equal(await redis.zcard(samplesKey), 1);
    const winner = (await redis.get(lockKey)) === a.token ? a : b;
    const loser = winner === a ? b : a;
    const first = JSON.parse((await redis.zrange(samplesKey, 0, -1))[0]);
    assert.equal(first.cpuPercent, null);
    const oldAt = Date.now() - 86400001;
    await redis.zadd(samplesKey, oldAt, JSON.stringify(sample(oldAt)));
    // Seed more than one day's maximum number of records to verify both caps.
    const pipeline = redis.pipeline();
    for (let i = 0; i < 8650; i++)
      pipeline.zadd(samplesKey, Date.now() - 50000 + i, JSON.stringify(sample(Date.now() - 50000 + i)));
    await pipeline.exec();
    await winner.collect();
    assert.equal(await redis.zcount(samplesKey, "-inf", oldAt), 0);
    assert.ok((await redis.zcard(samplesKey)) <= 8641);
    assert.ok((await redis.pttl(samplesKey)) > 86000000);
    await redis.del(lockKey);
    await loser.collect();
    assert.equal(await redis.get(lockKey), loser.token);
    const count = await redis.zcard(samplesKey);
    const history = await a.getSnapshot(24);
    assert.equal(history.unavailable, false);
    assert.equal(history.servers.length, 1);
    assert.ok(history.servers[0].points.length <= 721);
    assert.equal(await redis.zcard(samplesKey), count, "viewing history never triggers sampling");
  }
);
