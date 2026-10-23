const assert = require("node:assert/strict");
const { test, afterEach } = require("node:test");
const path = require("node:path");
require("reflect-metadata");
require("tsconfig-paths").register({ baseUrl: path.resolve(__dirname, "../dist"), paths: { "@/*": ["*"] } });
const { RedisService } = require("../dist/redis/redis.service");
const { RemoteProviderService } = require("../dist/remote-judge/remote-provider.service");
const { RemoteJudgeService } = require("../dist/remote-judge/remote-judge.service");
const { SubmissionMethod: Method } = require("../dist/remote-judge/remote-judge.types");

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

function redisFixture() {
  let duplicates = 0;
  const values = new Map();
  const client = {
    get: async key => values.get(key) ?? null,
    set: async (key, value) => {
      values.set(key, value);
      return "OK";
    },
    del: async key => values.delete(key),
    pttl: async () => 0,
    eval: async () => 1,
    duplicate: () => {
      duplicates++;
      return { ...client };
    }
  };
  // Use the real RedisService API; a test double returning one object for getClient()
  // hid the production leak because the real method opens a new connection.
  const service = Object.create(RedisService.prototype);
  service.client = client;
  return { service, client, duplicateCount: () => duplicates };
}

test("repeated provider requests, binding operations and worker turns do not allocate Redis connections", async () => {
  const redis = redisFixture();
  const lock = { lock: async (_, callback) => callback() };
  const provider = new RemoteProviderService(redis.service, lock, {
    get: async () => "test-session"
  });
  const account = { id: 1, userId: 1, nextSyncAt: new Date(0), failures: 0, cursor: "0" };
  const judge = Object.create(RemoteJudgeService.prototype);
  judge.redisService = redis.service;
  judge.lockService = lock;
  judge.configService = { config: {} };
  judge.provider = {
    verifyProfile: async () => true,
    getCodeforcesCooldownMs: () => provider.getCodeforcesCooldownMs()
  };
  judge.users = { findUserById: async () => ({ id: 1, isActive: false }) };
  judge.accounts = {
    createQueryBuilder: () => {
      const builder = { where: () => builder, orderBy: () => builder, getOne: async () => account };
      return builder;
    },
    findOneBy: async where => (where.id ? account : null),
    findBy: async () => [],
    create: value => value,
    save: async () => {},
    update: async () => {}
  };
  let fetches = 0;
  global.fetch = async address => {
    fetches++;
    if (new URL(address).pathname.endsWith("/submissions"))
      return new Response(
        `<table><thead><tr>${["Submission Time", "Task", "User", "Language", "Score", "Status"]
          .map(header => `<th>${header}</th>`)
          .join("")}</tr></thead><tbody></tbody></table>`
      );
    return new Response('{"status":"OK","result":[]}');
  };
  for (let i = 0; i < 100; i++) {
    await provider.getPage({ platform: Method.Codeforces, handle: "coder", cursor: "0" });
    await provider.request(Method.AtCoder, "https://atcoder.jp/users/coder");
    const page = await provider.getPage({ id: 1, platform: Method.AtCoder, handle: "coder", cursor: "0" }, [
      { contestId: "abc480", since: 0 }
    ]);
    await page.acknowledge();
    await judge.beginBinding({ id: i + 1 }, { platform: Method.Codeforces, handle: "coder" });
    await judge.verifyBinding({ id: i + 1 }, Method.Codeforces);
    await judge.unbind({ id: i + 1 }, Method.Codeforces);
    await judge.tick(Method.Codeforces);
    await judge.tick(Method.AtCoder);
  }
  assert.equal(fetches, 201, "cached empty searches do not repeatedly fetch the full list");
  assert.equal(redis.duplicateCount(), 0, "ordinary remote operations must reuse the shared command connection");
});

test("a failing upstream request does not leak Redis connections on repeated retries", async () => {
  const redis = redisFixture();
  const provider = new RemoteProviderService(redis.service, { lock: async (_, callback) => callback() }, {});
  global.fetch = async () => new Response("", { status: 503 });
  for (let i = 0; i < 50; i++) {
    await assert.rejects(
      provider.request(Method.Codeforces, "https://codeforces.com/api/user.info"),
      /REMOTE_UNAVAILABLE/
    );
  }
  assert.equal(redis.duplicateCount(), 0);
});

test("subscriptions and blocking consumers still obtain independent connections", () => {
  const redis = redisFixture();
  for (let i = 0; i < 1000; i++) assert.equal(redis.service.getSharedClient(), redis.client);
  assert.equal(redis.duplicateCount(), 0);
  const first = redis.service.getClient();
  const second = redis.service.getClient();
  assert.notEqual(first, second);
  assert.notEqual(first, redis.client);
  assert.equal(redis.duplicateCount(), 2);
});
