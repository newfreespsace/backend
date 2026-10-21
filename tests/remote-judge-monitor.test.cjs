const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
require("reflect-metadata");
require("tsconfig-paths").register({ baseUrl: path.resolve(__dirname, "../dist"), paths: { "@/*": ["*"] } });
const { RemoteJudgeMonitorService } = require("../dist/remote-judge/remote-judge-monitor.service");
const { RemoteJudgeController } = require("../dist/remote-judge/remote-judge.controller");
const { SubmissionEntity } = require("../dist/submission/submission.entity");
const { CodeforcesImportBufferEntity } = require("../dist/remote-judge/codeforces-import-buffer.entity");
const { RemoteWatchEntity } = require("../dist/remote-judge/remote-watch.entity");
const { ProblemEntity } = require("../dist/problem/problem.entity");

const CACHE = "remote-monitor:snapshot:v3";
function fixture(t) {
  const values = new Map(),
    registries = new Map(),
    lists = new Map(),
    expirations = new Map();
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
    lrange: async (key, start, end) => (lists.get(key) || []).slice(start, end + 1),
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
        expire: (key, seconds) => {
          commands.push(() => expirations.set(key, seconds));
          return pipeline;
        },
        lpush: (key, value) => {
          commands.push(() => lists.set(key, [value, ...(lists.get(key) || [])]));
          return pipeline;
        },
        ltrim: (key, start, end) => {
          commands.push(() => lists.set(key, lists.get(key).slice(start, end + 1)));
          return pipeline;
        },
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
    scheduled: { Codeforces: [], AtCoder: [] },
    bufferedProblems: [],
    watchedProblems: [],
    problemTitles: [],
    accounts: [],
    latest: {},
    pending: 0,
    fail: false,
    session: {
      atcoderSessionConfigured: true,
      atcoderSessionStatus: "valid",
      atcoderSessionLastCheckedAt: new Date(),
      atcoderSessionError: undefined
    }
  };
  const selected = [];
  const connection = {
    getRepository: entity =>
      entity === ProblemEntity
        ? {
            createQueryBuilder: () => {
              let ids = [];
              const builder = {
                leftJoin: () => builder,
                select: () => builder,
                addSelect: () => builder,
                where: (_, params) => {
                  ids = params.ids;
                  return builder;
                },
                getRawMany: async () => data.problemTitles.filter(row => ids.includes(row.id))
              };
              return builder;
            }
          }
        : entity === CodeforcesImportBufferEntity || entity === RemoteWatchEntity
        ? {
            createQueryBuilder: () => {
              const query = { params: {} };
              const builder = {
                select: sql => {
                  selected.push(sql);
                  return builder;
                },
                addSelect: sql => {
                  selected.push(sql);
                  return builder;
                },
                innerJoin: () => builder,
                where: (_, params) => {
                  Object.assign(query.params, params);
                  return builder;
                },
                groupBy: () => builder,
                addGroupBy: () => builder,
                orderBy: () => builder,
                addOrderBy: () => builder,
                limit: () => builder,
                getRawMany: async () =>
                  (entity === CodeforcesImportBufferEntity ? data.bufferedProblems : data.watchedProblems).filter(row =>
                    query.params.accountIds.includes(Number(row.accountId))
                  )
              };
              return builder;
            }
          }
        : entity === SubmissionEntity
        ? { countBy: async () => data.pending }
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
                  if (sql.includes("JSON_EXTRACT")) query.scheduled = true;
                  return builder;
                },
                where: (_, params) => {
                  Object.assign(query.params, params);
                  return builder;
                },
                andWhere: (_, params) => {
                  Object.assign(query.params, params);
                  return builder;
                },
                orderBy: () => builder,
                addOrderBy: () => builder,
                limit: () => builder,
                groupBy: () => {
                  query.grouped = true;
                  return builder;
                },
                getRawMany: async () => {
                  if (data.fail) throw new Error("test database unavailable");
                  if (query.grouped) return data.summaries;
                  if (query.scheduled)
                    return data.scheduled[query.params.platform]
                      .filter(row => !query.params.runningIds?.includes(row.accountId))
                      .sort((a, b) => +new Date(a.nextSyncAt) - +new Date(b.nextSyncAt))
                      .slice(0, 51);
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
  const settings = { getRemoteJudgeSettings: async () => data.session };
  const service = new RemoteJudgeMonitorService(connection, redisService, config, settings);
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
    lists,
    expirations,
    config,
    selected,
    connection,
    redisService,
    settings,
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
  f.data.session.atcoderSessionConfigured = false;
  assert.equal((await f.service.getSnapshot()).platforms[1].state, "Unconfigured");
  f.values.delete(CACHE);
  f.data.session.atcoderSessionConfigured = true;
  f.data.session.atcoderSessionStatus = "expired";
  const result = await f.service.getSnapshot(admin);
  assert.equal(result.platforms[1].state, "AuthExpired");
  assert.equal(result.platforms[1].sourceSupport, "Unavailable");
  assert.equal(requests, 0);
  f.config.config.remoteJudge.enabled = false;
  assert.ok((await f.service.getSnapshot()).platforms.every(row => row.state === "Disabled"));
});

test("cluster workers share live tasks and their stages, and expired workers are ignored", async t => {
  const f = fixture(t);
  await f.heartbeat();
  const second = new RemoteJudgeMonitorService(f.connection, f.redisService, f.config, f.settings);
  t.after(() => second.onModuleDestroy());
  f.data.accounts = [account({ lastError: null })];
  f.data.problemTitles = [
    { id: 11, displayId: 1001, title: "Two Melodies" },
    { id: 12, displayId: null, title: "Second Problem" }
  ];
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

test("completed rounds retain per-problem progress across workers, including partial failures and source errors", async t => {
  const f = fixture(t);
  await f.heartbeat();
  f.data.accounts = [account({ lastError: null })];
  f.data.problemTitles = [
    { id: 11, displayId: 1001, title: "Two Melodies" },
    { id: 12, displayId: null, title: "Second Problem" }
  ];
  f.service.startTask("Codeforces", 7, "Importing");
  f.service.setTaskProblems(
    "Codeforces",
    [
      { id: 11, title: "Two Melodies", remoteProblemKey: "813:D" },
      { id: 12, title: "Second Problem", remoteProblemKey: "813:E" }
    ],
    [
      { contestId: "813", taskId: "D", sourceCode: "private-source" },
      { contestId: "813", taskId: "E" }
    ]
  );
  f.service.beginProblem("Codeforces", 11);
  f.service.finishProblem("Codeforces", 11, true);
  f.service.beginProblem("Codeforces", 12);
  f.service.finishTask("Codeforces", {
    state: "Failed",
    continuation: "Retry",
    processed: 1,
    nextSyncAt: new Date(Date.now() + 60000).toISOString(),
    error: "REMOTE_UNAVAILABLE",
    sourceError: "REMOTE_CF_SOURCE_MISSING"
  });
  await f.service.publishing;
  const second = new RemoteJudgeMonitorService(f.connection, f.redisService, f.config, f.settings);
  t.after(() => second.onModuleDestroy());
  const result = await second.getSnapshot(admin);
  const round = result.platforms[0].admin.history[0];
  assert.equal(round.account.username, "student");
  assert.equal(round.state, "Failed");
  assert.equal(round.continuation, "Retry");
  assert.equal(round.problems[0].state, "Succeeded");
  assert.equal(round.problems[0].synchronized, 1);
  assert.equal(round.problems[0].displayId, 1001);
  assert.equal(round.problems[0].title, "Two Melodies");
  assert.equal(round.problems[1].state, "Failed");
  assert.equal(round.problems[1].processed, 0);
  assert.equal(round.sourceError, "REMOTE_CF_SOURCE_MISSING");
  assert.ok(round.durationMs >= 0);
  assert.equal(f.expirations.get("remote-monitor:history:Codeforces"), 604800);
  assert.doesNotMatch(JSON.stringify(result), /private-source/);
  assert.equal(f.duplicateCalls(), 0);
  const publicResult = await second.getSnapshot({ id: 2 });
  assert.doesNotMatch(JSON.stringify(publicResult), /Two Melodies|813:D|history|problemId|student/);
});

test("history is bounded and rejects expired, malformed or unexpected payload fields", async t => {
  const f = fixture(t);
  for (let i = 0; i < 103; i++) {
    f.service.startTask("AtCoder", 7, "Syncing");
    f.service.finishTask("AtCoder", {
      state: "Succeeded",
      continuation: "Pending",
      processed: i,
      error: null,
      sourceError: null,
      nextSyncAt: null
    });
  }
  await f.service.publishing;
  const key = "remote-monitor:history:AtCoder";
  assert.equal(f.lists.get(key).length, 100);
  const valid = JSON.parse(f.lists.get(key)[0]);
  f.lists.set(key, [
    "broken-json",
    JSON.stringify({
      ...valid,
      id: "a".repeat(24),
      finishedAt: new Date(Date.now() - 8 * 86400000),
      startedAt: new Date(Date.now() - 9 * 86400000)
    }),
    JSON.stringify({ ...valid, sourceCode: "private-source", error: "private-raw-response" })
  ]);
  const result = await f.service.getSnapshot(admin);
  assert.equal(result.platforms[1].admin.history.length, 1);
  assert.equal(result.platforms[1].admin.history[0].error, "REMOTE_SYNC_FAILED");
  assert.doesNotMatch(JSON.stringify(result), /private-source|private-raw-response/);
  f.values.delete(CACHE);
  f.redis.lrange = async () => {
    throw new Error("unavailable");
  };
  assert.equal((await f.service.getSnapshot(admin)).platforms[0].admin.historyAvailable, false);
});

test("scheduled tasks exclude running accounts and identify buffered problems separately from watched problems", async t => {
  const f = fixture(t);
  await f.heartbeat();
  f.data.summaries[0].activeAccounts = 4;
  f.data.accounts = [account({ lastError: null })];
  f.data.scheduled.Codeforces = [
    account({ accountId: 7, lastError: null, nextSyncAt: new Date(0), phase: "Importing" }),
    account({ accountId: 8, lastError: null, nextSyncAt: new Date(1), phase: "Collecting" }),
    account({ accountId: 9, lastError: null, nextSyncAt: new Date(Date.now() + 60000) }),
    account({ accountId: 10, nextSyncAt: new Date(Date.now() + 120000) })
  ];
  f.data.bufferedProblems = [
    { accountId: 8, problemId: 11, title: "Two Melodies", remoteKey: "813:D", records: "14", state: "Collecting" }
  ];
  f.data.watchedProblems = [
    { accountId: 8, problemId: 11, title: "Two Melodies", remoteKey: "813:D" },
    { accountId: 9, problemId: 12, title: "Watching problem", remoteKey: "813:E" }
  ];
  f.service.startTask("Codeforces", 7, "Importing");
  await f.service.publishing;
  let detail = (await f.service.getSnapshot(admin)).platforms[0].admin;
  assert.equal(detail.scheduledTaskTotal, 3);
  assert.deepEqual(
    detail.scheduledTasks.map(task => task.state),
    ["Queued", "Scheduled", "Retrying"]
  );
  assert.equal(detail.scheduledTasks[0].problems.length, 1);
  assert.equal(detail.scheduledTasks[0].problems[0].records, 14);
  assert.equal(detail.scheduledTasks[0].problems[0].scope, "Buffer");
  assert.equal(detail.scheduledTasks[0].problems[0].state, "Collecting");
  assert.equal(detail.scheduledTasks[1].problems[0].state, "Watching");
  assert.equal(detail.scheduledTasks[1].problems[0].records, null);
  assert.equal(detail.scheduledTasks[1].problems[0].scope, "Watch");
  assert.doesNotMatch(f.selected.join(" "), /entry\.payload|sourceCode/);
  f.values.delete(CACHE);
  f.data.scheduled.AtCoder = [account({ accountId: 20, lastError: null })];
  f.data.session.atcoderSessionConfigured = false;
  assert.equal((await f.service.getSnapshot(admin)).platforms[1].admin.scheduledTasks[0].state, "Paused");
  f.values.delete(CACHE);
  f.data.scheduled.Codeforces = Array.from({ length: 51 }, (_, i) =>
    account({ accountId: 100 + i, lastError: null, nextSyncAt: new Date(i) })
  );
  detail = (await f.service.getSnapshot(admin)).platforms[0].admin;
  assert.equal(detail.scheduledTasks.length, 50);
  assert.equal(detail.scheduledTasksTruncated, true);
});
