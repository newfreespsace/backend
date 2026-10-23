const assert = require("node:assert/strict");
const { test, afterEach } = require("node:test");
const path = require("node:path");
require("reflect-metadata");
require("tsconfig-paths").register({ baseUrl: path.resolve(__dirname, "../dist"), paths: { "@/*": ["*"] } });
const { RemoteProviderService } = require("../dist/remote-judge/remote-provider.service");
const { CODEFORCES_COOLDOWN_KEY, CODEFORCES_FAILURES_KEY } = require("../dist/remote-judge/codeforces-policy");
const { logger } = require("../dist/logger");

const originalFetch = global.fetch;
const originalWarn = logger.warn;
afterEach(() => {
  global.fetch = originalFetch;
  logger.warn = originalWarn;
});

function fixture(t) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1700000000000 });
  logger.warn = () => {};
  const values = new Map();
  const expires = new Map();
  const get = key => {
    if (expires.has(key) && expires.get(key) <= Date.now()) {
      values.delete(key);
      expires.delete(key);
    }
    return values.get(key);
  };
  const redis = {
    get: async key => get(key) ?? null,
    pttl: async key => (get(key) === undefined ? -2 : expires.has(key) ? expires.get(key) - Date.now() : -1),
    set: async (key, value, unit, ttl) => {
      values.set(key, value);
      expires.set(key, Date.now() + (unit === "EX" ? ttl * 1000 : ttl));
      return "OK";
    },
    incr: async key => {
      const value = Number(get(key) || 0) + 1;
      values.set(key, String(value));
      return value;
    },
    pexpire: async (key, ttl) => expires.set(key, Date.now() + ttl),
    del: async key => {
      expires.delete(key);
      return values.delete(key);
    }
  };
  let tail = Promise.resolve();
  const lock = {
    lock: async (_, fn) => {
      const result = tail.then(fn);
      tail = result.catch(() => {});
      return result;
    }
  };
  const provider = () => {
    const instance = Object.create(RemoteProviderService.prototype);
    instance.redisService = { getSharedClient: () => redis };
    instance.lockService = lock;
    instance.codeforcesCredentials = { get: async () => ({ apiKey: "testKey", apiSecret: "testSecret" }) };
    return instance;
  };
  return { redis, provider };
}

const account = id => ({ id, platform: "Codeforces", handle: "coder", cursor: "900", codeforcesSourceEnabled: true });
const success = () => new Response(JSON.stringify({ status: "OK", result: [] }));

for (const scenario of [
  {
    name: "challenge header on HTTP 403",
    status: 403,
    headers: { "cf-mitigated": "challenge" },
    error: "REMOTE_VERIFICATION_REQUIRED",
    cooldown: 900000
  },
  {
    name: "challenge header on HTTP 200",
    status: 200,
    headers: { "cf-mitigated": "challenge" },
    error: "REMOTE_VERIFICATION_REQUIRED",
    cooldown: 900000
  },
  {
    name: "HTML returned from API",
    status: 200,
    body: "<!DOCTYPE html><title>Just a moment...</title>",
    error: "REMOTE_VERIFICATION_REQUIRED",
    cooldown: 900000
  },
  { name: "access denial", status: 403, error: "REMOTE_ACCESS_DENIED", cooldown: 900000 },
  { name: "HTTP rate limit", status: 429, error: "REMOTE_RATE_LIMITED", cooldown: 300000 },
  {
    name: "numeric Retry-After",
    status: 429,
    headers: { "retry-after": "7200" },
    error: "REMOTE_RATE_LIMITED",
    cooldown: 7200000
  },
  {
    name: "date Retry-After",
    status: 429,
    headers: { "retry-after": new Date(1700000000000 + 1200000).toUTCString() },
    error: "REMOTE_RATE_LIMITED",
    cooldown: 1200000
  },
  {
    name: "API rate limit on HTTP 200",
    status: 200,
    body: JSON.stringify({ status: "FAILED", comment: "Call limit exceeded" }),
    error: "REMOTE_RATE_LIMITED",
    cooldown: 300000
  },
  {
    name: "API rate limit on HTTP 400",
    status: 400,
    body: JSON.stringify({ status: "FAILED", comment: "Call limit exceeded" }),
    error: "REMOTE_RATE_LIMITED",
    cooldown: 300000
  }
]) {
  test(`${scenario.name} pauses source, public result and verification requests across workers`, async t => {
    const f = fixture(t);
    let calls = 0;
    let release;
    const ready = new Promise(resolve => {
      release = resolve;
    });
    global.fetch = async () => {
      calls++;
      await ready;
      return new Response(scenario.body || "denied", { status: scenario.status, headers: scenario.headers });
    };
    const sourceWorker = f.provider();
    const otherWorker = f.provider();
    // Queue both before the first failure is processed to exercise the lock boundary.
    const sourceRequest = sourceWorker.getPage(account(1));
    await new Promise(setImmediate);
    const verification = otherWorker.verifyProfile("Codeforces", "coder", "proof");
    release();
    const results = await Promise.allSettled([sourceRequest, verification]);
    assert.equal(results[0].status, "rejected");
    assert.equal(results[0].reason.message, scenario.error);
    assert.equal(results[1].status, "rejected");
    assert.equal(results[1].reason.message, "REMOTE_COOLDOWN");
    await assert.rejects(otherWorker.getPage({ ...account(2), codeforcesSourceEnabled: false }), /REMOTE_COOLDOWN/);
    assert.equal(calls, 1, "no retry, public fallback, or queued verification may contact CF");
    assert.equal(await sourceWorker.getCodeforcesCooldownMs(), scenario.cooldown);
    assert.equal(await f.redis.get(CODEFORCES_COOLDOWN_KEY), scenario.error);
  });
}

test("an expired pause admits one serialized probe, escalates on failure, and recovers on success", async t => {
  const f = fixture(t);
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return new Response("denied", { status: 403 });
  };
  await assert.rejects(f.provider().getPage(account(1)), /REMOTE_ACCESS_DENIED/);
  t.mock.timers.tick(900000);
  const results = await Promise.allSettled([f.provider().getPage(account(1)), f.provider().getPage(account(2))]);
  assert.equal(results[0].reason.message, "REMOTE_ACCESS_DENIED");
  assert.equal(results[1].reason.message, "REMOTE_COOLDOWN");
  assert.equal(calls, 2);
  assert.equal(await f.provider().getCodeforcesCooldownMs(), 1800000);
  t.mock.timers.tick(1800000);
  global.fetch = async () => {
    calls++;
    return success();
  };
  await f.provider().getPage(account(2));
  assert.equal(calls, 3);
  assert.equal(await f.redis.get(CODEFORCES_FAILURES_KEY), null);
  assert.equal(await f.provider().getCodeforcesCooldownMs(), 0);
});

test("source, public and verification requests share a five-second minimum interval", async t => {
  const f = fixture(t);
  const sent = [];
  global.fetch = async () => {
    sent.push(Date.now());
    return success();
  };
  await f.provider().getPage(account(1));
  const publicRequest = f.provider().getPage({ ...account(2), codeforcesSourceEnabled: false });
  await new Promise(setImmediate);
  t.mock.timers.tick(4999);
  await new Promise(setImmediate);
  assert.equal(sent.length, 1);
  t.mock.timers.tick(1);
  await publicRequest;
  const verification = f.provider().verifyProfile("Codeforces", "coder", "proof");
  await new Promise(setImmediate);
  t.mock.timers.tick(5000);
  await verification;
  assert.deepEqual(
    sent.map(at => at - sent[0]),
    [0, 5000, 10000]
  );
});

test("invalid API credentials on HTTP 400 still allow public result sync without a global pause", async t => {
  const f = fixture(t);
  let calls = 0;
  global.fetch = async address => {
    calls++;
    return new URL(address).searchParams.has("apiKey")
      ? new Response(JSON.stringify({ status: "FAILED", comment: "Invalid API key" }), { status: 400 })
      : success();
  };
  const request = f.provider().getPage(account(1));
  await new Promise(setImmediate);
  t.mock.timers.tick(5000);
  const page = await request;
  assert.equal(calls, 2);
  assert.equal(page.sourceError, "REMOTE_CF_AUTH_FAILED");
  assert.equal(await f.provider().getCodeforcesCooldownMs(), 0);
});
