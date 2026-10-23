const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
require("reflect-metadata");
require("tsconfig-paths").register({ baseUrl: path.resolve(__dirname, "../dist"), paths: { "@/*": ["*"] } });
const { RemoteJudgeMonitorService } = require("../dist/remote-judge/remote-judge-monitor.service");
const { RemoteJudgeController } = require("../dist/remote-judge/remote-judge.controller");
const { SubmissionEntity } = require("../dist/submission/submission.entity");

const CACHE = "remote-monitor:snapshot:v1";
function fixture(t) {
  const values = new Map(),
    registries = new Map(),
    histories = new Map();
  const expirations = [];
  let duplicateCalls = 0,
    queryCount = 0;
  const redis = {
    status: "ready",
    rejected: 8,
    get: async key => values.get(key) || null,
    set: async (key, value) => {
      values.set(key, value);
      return "OK";
    },
    del: async key => values.delete(key),
    info: async section =>
      section === "clients"
        ? "connected_clients:24\r\nmaxclients:10000\r\n"
        : `rejected_connections:${redis.rejected}\r\n`,
    zrangebyscore: async (key, min) =>
      [...(registries.get(key) || new Map())].filter(([, score]) => score >= min).map(([id]) => id),
    mget: async (...keys) => keys.map(key => values.get(key) || null),
    lrange: async (key, start, end) => (histories.get(key) || []).slice(start, end + 1),
    multi: () => {
      const commands = [];
      const transaction = {
        lpush: (key, value) => {
          commands.push(() => histories.set(key, [value, ...(histories.get(key) || [])]));
          return transaction;
        },
        ltrim: (key, start, end) => {
          commands.push(() => histories.set(key, histories.get(key).slice(start, end + 1)));
          return transaction;
        },
        expire: (key, seconds) => {
          expirations.push({ key, seconds });
          return transaction;
        },
        exec: async () => {
          commands.forEach(command => command());
          return [];
        }
      };
      return transaction;
    },
    pipeline: () => {
      const commands = [];
      const pipeline = {
        zremrangebyscore: (key, _, max) => {
          commands.push(() => {
            const rows = registries.get(key);
            if (rows) for (const [id, score] of rows) if (score <= max) rows.delete(id);
          });
          return pipeline;
        },
        zadd: (key, score, id) => {
          commands.push(() => {
            if (!registries.has(key)) registries.set(key, new Map());
            registries.get(key).set(id, score);
          });
          return pipeline;
        },
        expire: () => pipeline,
        set: (key, value) => {
          commands.push(() => values.set(key, value));
          return pipeline;
        },
        exec: async () => {
          commands.forEach(command => command());
          return [];
        }
      };
      return pipeline;
    }
  };
  const data = {
    summaries: ["Codeforces", "AtCoder"].map(platform => ({
      platform,
      boundAccounts: 2,
      activeAccounts: 1,
      queuedAccounts: 0,
      retryingAccounts: 0,
      historyAccounts: 0,
      errorAccounts: 0,
      sourceErrorAccounts: 0,
      abnormalAccounts: 0,
      lastSyncedAt: new Date(),
      oldestQueuedAt: null
    })),
    errors: { Codeforces: [], AtCoder: [] },
    accounts: [],
    latest: {},
    pending: 0,
    sourcePending: 0,
    sourceFailed: 0,
    fail: false,
    atcoderSessionAccounts: 1
  };
  const selected = [];
  const connection = {
    getRepository: entity =>
      entity === SubmissionEntity
        ? {
            countBy: async () => data.pending,
            createQueryBuilder: () => {
              const params = {};
              const builder = {
                where: (_, input) => {
                  Object.assign(params, input);
                  return builder;
                },
                andWhere: (_, input) => {
                  Object.assign(params, input);
                  return builder;
                },
                getCount: async () => (params.sourceStatus === "Pending" ? data.sourcePending : data.sourceFailed)
              };
              return builder;
            }
          }
        : {
            createQueryBuilder: () => {
              queryCount++;
              const query = { params: {}, grouped: false };
              const builder = {
                leftJoin: () => builder,
                select: sql => {
                  selected.push(sql);
                  return builder;
                },
                addSelect: sql => {
                  selected.push(sql);
                  return builder;
                },
                where: (_, params) => {
                  Object.assign(query.params, params);
                  return builder;
                },
                andWhere: () => builder,
                orderBy: () => builder,
                addOrderBy: () => builder,
                limit: () => builder,
                groupBy: () => {
                  query.grouped = true;
                  return builder;
                },
                getRawMany: async () => {
                  if (data.fail) throw new Error("test database unavailable");
                  if (query.grouped)
                    return data.summaries.map(row => ({
                      ...row,
                      sessionAccounts: row.platform === "AtCoder" ? data.atcoderSessionAccounts : 0
                    }));
                  if (query.params.ids) return data.accounts.filter(row => query.params.ids.includes(row.accountId));
                  return data.errors[query.params.platform].slice(0, 20);
                },
                getRawOne: async () => data.latest[query.params.platform]
              };
              return builder;
            }
          }
  };
  const config = { config: { remoteJudge: { enabled: true } } };
  const redisService = {
    getSharedClient: () => redis,
    getClient: () => {
      duplicateCalls++;
      throw new Error("must reuse Redis connection");
    }
  };
  const service = new RemoteJudgeMonitorService(connection, redisService, config);
  t.after(() => service.onModuleDestroy());
  const heartbeat = async () => {
    service.onModuleInit();
    await service.publishing;
  };
  return {
    service,
    data,
    redis,
    values,
    registries,
    histories,
    expirations,
    config,
    selected,
    connection,
    redisService,
    heartbeat,
    queryCount: () => queryCount,
    duplicateCalls: () => duplicateCalls
  };
}
const admin = { id: 1, isAdmin: true };
const account = (overrides = {}) => ({
  accountId: 7,
  userId: 2,
  username: "student",
  handle: "remote-coder",
  lastError: "REMOTE_UNAVAILABLE",
  lastErrorAt: new Date(),
  nextSyncAt: new Date(Date.now() + 60000),
  sourceError: null,
  sourceRetryAt: null,
  ...overrides
});

test("public projections never expose administrative details, including after an admin warms the shared cache", async t => {
  const f = fixture(t);
  await f.heartbeat();
  f.data.summaries[0].errorAccounts = 1;
  f.data.errors.Codeforces = [
    account({
      codeforcesCredentials: "private-ciphertext",
      email: "private-email",
      sourceCode: "private-code",
      token: "private-token",
      lastError: "private-raw-error"
    })
  ];
  const controller = new RemoteJudgeController({}, f.service);
  const detailed = await controller.getMonitor(admin);
  assert.equal(detailed.platforms[0].admin.errors[0].lastError, "REMOTE_SYNC_FAILED");
  assert.doesNotMatch(JSON.stringify(detailed), /private-/);
  const queries = f.queryCount();
  for (const viewer of [undefined, { id: 2 }, { id: 3, isAdmin: false }]) {
    const result = await controller.getMonitor(viewer);
    assert.equal(result.admin, undefined);
    assert.equal(result.platforms[0].admin, undefined);
    assert.doesNotMatch(JSON.stringify(result), /student|remote-coder|connectedClients|accountId|retryingAccounts/);
  }
  assert.equal(f.queryCount(), queries, "viewing cached monitoring data must not rescan accounts");
  assert.doesNotMatch(f.selected.join(" "), /Credentials|sourceCode|email|token|SELECT \*/);
  assert.equal(f.duplicateCalls(), 0);
});

test("fresh heartbeats make idle normal while stale heartbeats never mark an active platform healthy", async t => {
  const f = fixture(t);
  await f.heartbeat();
  f.data.summaries[0].activeAccounts = 0;
  f.data.summaries[0].lastSyncedAt = new Date(Date.now() - 86400000);
  assert.equal((await f.service.getSnapshot()).platforms[0].state, "Idle");
  f.values.delete(CACHE);
  f.data.summaries[0].activeAccounts = 1;
  f.data.summaries[0].lastSyncedAt = new Date();
  for (const [key, value] of f.values)
    if (key.startsWith("remote-monitor:worker:")) {
      const row = JSON.parse(value);
      row.at = new Date(Date.now() - 60000).toISOString();
      f.values.set(key, JSON.stringify(row));
    }
  assert.equal((await f.service.getSnapshot()).platforms[0].state, "Unknown");
});

test("source-only and individual account errors do not label a healthy whole platform as failed", async t => {
  const f = fixture(t);
  await f.heartbeat();
  Object.assign(f.data.summaries[0], {
    activeAccounts: 4,
    retryingAccounts: 1,
    errorAccounts: 1,
    sourceErrorAccounts: 1,
    abnormalAccounts: 1
  });
  f.data.latest.Codeforces = { error: "REMOTE_ACCESS_DENIED", at: new Date() };
  f.data.errors.Codeforces = [
    account({ sourceError: "REMOTE_CF_AUTH_FAILED", sourceRetryAt: new Date(Date.now() + 300000) })
  ];
  const result = await f.service.getSnapshot(admin);
  assert.equal(result.platforms[0].state, "Healthy");
  assert.equal(result.platforms[0].admin.errorsTruncated, false, "an account failing in two ways is still one account");
  assert.ok(result.platforms[0].admin.errors[0].sourceErrorAt);
  f.values.delete(CACHE);
  Object.assign(f.data.summaries[0], { retryingAccounts: 0, errorAccounts: 0 });
  assert.equal((await f.service.getSnapshot()).platforms[0].state, "Healthy");
});

test("a recent shared failure affecting all tracked accounts reports rate limits or access failure", async t => {
  const f = fixture(t);
  await f.heartbeat();
  Object.assign(f.data.summaries[0], {
    activeAccounts: 2,
    retryingAccounts: 2,
    lastSyncedAt: new Date(Date.now() - 10000)
  });
  f.data.latest.Codeforces = { error: "REMOTE_RATE_LIMITED", at: new Date() };
  assert.equal((await f.service.getSnapshot()).platforms[0].state, "RateLimited");
  f.values.delete(CACHE);
  f.data.latest.Codeforces.error = "REMOTE_ACCESS_DENIED";
  assert.equal((await f.service.getSnapshot()).platforms[0].state, "Error");
  f.values.delete(CACHE);
  f.data.latest.Codeforces = { error: "REMOTE_ACCESS_DENIED", at: new Date(Date.now() - 3600000) };
  f.data.summaries[0].lastSyncedAt = new Date(Date.now() - 3600001);
  assert.equal((await f.service.getSnapshot()).platforms[0].state, "Unknown");
});

test("AtCoder distinguishes missing and expired sessions; monitoring does not make original-site requests", async t => {
  const f = fixture(t);
  await f.heartbeat();
  const previous = global.fetch;
  let requests = 0;
  global.fetch = async () => {
    requests++;
    throw new Error("monitoring must not fetch original sites");
  };
  t.after(() => {
    global.fetch = previous;
  });
  f.data.atcoderSessionAccounts = 0;
  assert.equal((await f.service.getSnapshot()).platforms[1].state, "Unconfigured");
  f.values.delete(CACHE);
  f.data.atcoderSessionAccounts = 1;
  const at = f.data.summaries.find(row => row.platform === "AtCoder");
  at.activeAccounts = 1;
  at.retryingAccounts = 1;
  f.data.latest.AtCoder = { error: "REMOTE_AUTH_REQUIRED", at: new Date() };
  const result = await f.service.getSnapshot(admin);
  assert.equal(result.platforms[1].state, "AuthExpired");
  assert.equal(result.platforms[1].sourceSupport, "PersonalSession");
  assert.equal(requests, 0);
  f.config.config.remoteJudge.enabled = false;
  assert.ok((await f.service.getSnapshot()).platforms.every(row => row.state === "Disabled"));
});

test("cluster workers share live tasks and their stages, and expired workers are ignored", async t => {
  const f = fixture(t);
  await f.heartbeat();
  const second = new RemoteJudgeMonitorService(f.connection, f.redisService, f.config);
  t.after(() => second.onModuleDestroy());
  f.data.accounts = [account({ lastError: null })];
  second.startTask("Codeforces", 7, "Collecting");
  await second.publishing;
  let result = await f.service.getSnapshot(admin);
  assert.equal(result.platforms[0].state, "Syncing");
  assert.equal(result.platforms[0].admin.liveWorkers, 2);
  assert.equal(result.platforms[0].admin.tasks[0].phase, "Collecting");
  f.values.delete(CACHE);
  second.setTaskPhase("Codeforces", "Importing");
  await second.publishing;
  result = await f.service.getSnapshot(admin);
  assert.equal(result.platforms[0].admin.tasks[0].phase, "Importing");
  second.finishTask("Codeforces");
  await second.publishing;
  f.values.delete(CACHE);
  assert.equal((await f.service.getSnapshot(admin)).platforms[0].admin.tasks.length, 0);
});

test("Redis rejection deltas handle first samples, increases, resets and an unavailable connection", async t => {
  const f = fixture(t);
  await f.heartbeat();
  let info = (await f.service.getSnapshot(admin)).admin.redis;
  assert.equal(info.connectedClients, 24);
  assert.equal(info.maxClients, 10000);
  assert.equal(info.rejectedConnections, 8);
  assert.equal(info.rejectedDelta, null);
  f.values.delete(CACHE);
  f.redis.rejected = 11;
  info = (await f.service.getSnapshot(admin)).admin.redis;
  assert.equal(info.rejectedDelta, 3);
  assert.ok(info.deltaSince);
  f.values.delete(CACHE);
  f.redis.rejected = 0;
  assert.equal((await f.service.getSnapshot(admin)).admin.redis.rejectedDelta, null);
  f.redis.status = "reconnecting";
  const result = await f.service.getSnapshot(admin);
  assert.equal(result.admin.redis.available, false);
  assert.equal(result.platforms[0].state, "Unknown");
  assert.equal(f.duplicateCalls(), 0);
});

test("database failures retain a stale snapshot and never expose admin data to ordinary viewers", async t => {
  const f = fixture(t);
  await f.heartbeat();
  f.data.errors.Codeforces = [account()];
  await f.service.getSnapshot(admin);
  f.values.delete(CACHE);
  f.data.fail = true;
  const result = await f.service.getSnapshot({ id: 2 });
  assert.equal(result.stale, true);
  assert.equal(result.unavailable, true);
  assert.ok(result.platforms.every(row => row.state === "Unknown"));
  assert.doesNotMatch(JSON.stringify(result), /remote-coder|student|connectedClients/);
});

test("detailed errors survive recovery and are shared across workers without exposing request secrets", async t => {
  const f = fixture(t);
  const at = new Date();
  const details = {
    stage: "parse",
    reason: "INVALID_SUBMISSION_TIME",
    contestId: "abc480",
    page: 2,
    submissionId: "12345",
    cookie: "private-cookie",
    html: "private-source",
    url: "https://secret.test"
  };
  await f.service.recordError(
    { id: 7, userId: 2, handle: "remote-coder", platform: "AtCoder" },
    { id: 2, username: "student" },
    { error: "REMOTE_PARSE_FAILED", at, details }
  );
  f.data.errors.AtCoder = [account({ lastError: "REMOTE_PARSE_FAILED", lastErrorAt: at })];
  let result = await f.service.getSnapshot(admin);
  let platform = result.platforms[1].admin;
  assert.equal(platform.recentErrors.length, 1);
  assert.equal(platform.errors[0].lastErrorDetails.reason, "INVALID_SUBMISSION_TIME");
  assert.deepEqual(platform.recentErrors[0].details, {
    stage: "parse",
    reason: "INVALID_SUBMISSION_TIME",
    contestId: "abc480",
    page: 2,
    submissionId: "12345"
  });
  assert.doesNotMatch(JSON.stringify(result), /private-cookie|private-source|secret.test/);
  f.data.errors.AtCoder = [];
  f.values.delete(CACHE);
  const otherWorker = new RemoteJudgeMonitorService(f.connection, f.redisService, f.config);
  result = await otherWorker.getSnapshot(admin);
  platform = result.platforms[1].admin;
  assert.equal(platform.errors.length, 0);
  assert.equal(platform.recentErrors.length, 1, "recovery does not erase history");
  assert.deepEqual(f.expirations, [{ key: "remote-monitor:errors:AtCoder", seconds: 7 * 86400 }]);
  const publicSnapshot = await otherWorker.getSnapshot({ id: 2 });
  assert.doesNotMatch(
    JSON.stringify(publicSnapshot),
    /student|remote-coder|recentErrors|INVALID_SUBMISSION_TIME|abc480/
  );
});

test("history keeps the newest 50 errors per platform and ignores expired or malformed entries", async t => {
  const f = fixture(t);
  const account = { id: 7, userId: 2, handle: "coder", platform: "AtCoder" };
  for (let i = 0; i < 55; i++) {
    await f.service.recordError(account, undefined, {
      error: "REMOTE_PARSE_FAILED",
      at: new Date(),
      details: { page: i + 1 }
    });
  }
  assert.equal(f.histories.get("remote-monitor:errors:AtCoder").length, 50);
  let history = await f.service.errorHistory("AtCoder");
  assert.equal(history.events[0].details.page, 55);
  assert.equal(history.events.at(-1).details.page, 6);
  assert.equal((await f.service.errorHistory("Codeforces")).events.length, 0);
  const expired = { ...history.events[0], at: new Date(Date.now() - 8 * 86400000).toISOString() };
  f.histories.set("remote-monitor:errors:AtCoder", [
    "invalid json",
    JSON.stringify(expired),
    JSON.stringify(history.events[0])
  ]);
  history = await f.service.errorHistory("AtCoder");
  assert.equal(history.available, true);
  assert.equal(history.events.length, 1);
});

test("history storage failure is isolated from synchronization and reported as unavailable", async t => {
  const f = fixture(t);
  f.redis.multi = () => {
    throw new Error("Redis unavailable");
  };
  await assert.doesNotReject(
    f.service.recordError({ id: 7, userId: 2, handle: "coder", platform: "AtCoder" }, undefined, {
      error: "REMOTE_PARSE_FAILED",
      at: new Date()
    })
  );
  f.redis.lrange = async () => {
    throw new Error("Redis unavailable");
  };
  const result = await f.service.getSnapshot(admin);
  assert.equal(result.platforms[1].admin.errorHistoryAvailable, false);
  assert.deepEqual(result.platforms[1].admin.recentErrors, []);
});

test("CF shared cooldown is visible even when only a binding request failed", async t => {
  const f = fixture(t);
  f.values.set("remote-codeforces-cooldown", "REMOTE_RATE_LIMITED");
  let result = await f.service.getSnapshot(admin);
  assert.equal(result.platforms[0].state, "RateLimited");
  f.values.delete(CACHE);
  f.values.set("remote-codeforces-cooldown", "REMOTE_VERIFICATION_REQUIRED");
  result = await f.service.getSnapshot(admin);
  assert.equal(result.platforms[0].state, "Error");
  assert.notEqual(result.platforms[1].state, "Error");
});
