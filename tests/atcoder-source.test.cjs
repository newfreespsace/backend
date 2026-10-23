const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
require("reflect-metadata");
require("tsconfig-paths").register({ baseUrl: path.resolve(__dirname, "../dist"), paths: { "@/*": ["*"] } });
const { parseAtcoderSource } = require("../dist/remote-judge/atcoder-source.parser");
const { AtcoderSourceService } = require("../dist/remote-judge/atcoder-source.service");
const { RemoteProviderService } = require("../dist/remote-judge/remote-provider.service");
const { SubmissionEntity } = require("../dist/submission/submission.entity");
const { RemoteAccountEntity } = require("../dist/remote-judge/remote-account.entity");
const { SubmissionStatus: Status } = require("../dist/submission/submission-status.enum");

const identity = { id: "12345", contestId: "abc001", taskId: "abc001_1", handle: "coder" };
const source = "\uFEFF// 中文\r\nint main() { return 1 < 2 && 3 > 2; }\n// &lt; must remain literal\n";
function page(code = source, expected = identity) {
  const escaped = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<span class="h2">Submission #${expected.id}</span>
    <form action="/logout?continue=%2F"></form><pre id="submission-code">${escaped}</pre>
    <table><tr><th>Task</th><td><a href="/contests/${expected.contestId}/tasks/${expected.taskId}">Task</a></td></tr>
    <tr><th>User</th><td><a href="/users/${expected.handle}">${expected.handle}</a></td></tr></table>`;
}

test("source parsing verifies the submission, task and author and preserves entities, BOM, Unicode and line endings", () => {
  assert.equal(parseAtcoderSource(page(), identity), source);
  assert.equal(parseAtcoderSource(page(), { ...identity, handle: "CODER" }), source);
  for (const field of ["id", "contestId", "taskId", "handle"])
    assert.throws(
      () => parseAtcoderSource(page(), { ...identity, [field]: "different" }),
      /REMOTE_SOURCE_IDENTITY_MISMATCH/
    );
  assert.throws(() => parseAtcoderSource(page("  \n"), identity), /REMOTE_SOURCE_MISSING/);
  assert.throws(() => parseAtcoderSource(page("中".repeat(400000)), identity), /REMOTE_SOURCE_TOO_LARGE/);
  assert.throws(
    () => parseAtcoderSource('<form action="/login?continue=%2F"></form>', identity),
    /REMOTE_AUTH_REQUIRED/
  );
});

test("production source fetch uses the validated UA, dedicated session and original-site limiter", async t => {
  const provider = Object.create(RemoteProviderService.prototype);
  const calls = [],
    rate = [],
    locks = [];
  let credentialReads = 0;
  provider.atcoderSessions = {
    get: async () => {
      credentialReads++;
      return "private-session";
    }
  };
  provider.redisService = { getSharedClient: () => ({ pttl: async () => 0, set: async (...args) => rate.push(args) }) };
  provider.lockService = {
    lock: async (key, fn) => {
      locks.push(key);
      return fn();
    }
  };
  t.mock.method(global, "fetch", async (url, options) => {
    calls.push({ url, options });
    return new Response(page());
  });
  const context = await provider.getAtcoderSessionContext(1);
  assert.equal(await provider.getAtcoderSource(identity, 1, context), source);
  assert.equal(credentialReads, 1);
  assert.equal(calls[0].url, "https://atcoder.jp/contests/abc001/submissions/12345");
  assert.match(calls[0].options.headers["User-Agent"], /^Mozilla\//);
  assert.equal(calls[0].options.headers.Cookie, "REVEL_SESSION=private-session");
  assert.equal(calls[0].options.headers.Accept, "text/html");
  assert.equal(calls[0].options.redirect, "manual");
  assert.equal(rate[0][3], 1500);
  assert.equal(locks[0], "RemoteProvider_AtCoder");
  calls.length = 0;
  await assert.rejects(provider.getAtcoderSource({ ...identity, contestId: "../evil" }, 1), /IDENTITY_MISMATCH/);
  assert.equal(calls.length, 0);
});

test("source access errors propagate their original error codes", async () => {
  const provider = Object.create(RemoteProviderService.prototype);
  provider.atcoderSessions = {
    get: async () => "private-session"
  };
  for (const code of ["REMOTE_ACCESS_DENIED", "REMOTE_RATE_LIMITED", "REMOTE_AUTH_REQUIRED"]) {
    provider.request = async () => {
      throw new Error(code);
    };
    await assert.rejects(provider.getAtcoderSource(identity, 1), new RegExp(code));
  }
});

function fixture() {
  const service = Object.create(AtcoderSourceService.prototype);
  const row = {
    id: 9,
    remoteKey: "AtCoder:12345:7",
    submitterId: 1,
    problemId: 7,
    status: Status.Accepted,
    submitTime: new Date(Date.now() - 3600000),
    remote: {
      ...identity,
      submittedAt: Math.floor((Date.now() - 3600000) / 1000),
      platform: "AtCoder",
      language: "C++23",
      historical: true,
      sourceSync: {
        status: "Pending",
        readyAt: new Date(0).toISOString(),
        nextAttemptAt: new Date(0).toISOString(),
        failures: 0
      }
    }
  };
  const state = {
    row,
    account: { id: 3, userId: 1, handle: "coder", handleKey: "coder", platform: "AtCoder" },
    problem: { id: 7, submissionMethod: "AtCoder", remoteProblem: { contestId: "abc001", taskId: "abc001_1" } },
    restricted: [],
    allowed: true,
    active: true,
    session: true,
    due: 0,
    fetches: 0,
    saves: 0,
    updates: [],
    released: 0,
    discover: []
  };
  const submissionRepository = {
    findOneBy: async () => state.row,
    update: async (where, update) => {
      state.updates.push({ where, update });
      Object.assign(state.row, structuredClone(update));
    },
    createQueryBuilder: () => {
      let sourceNow;
      const builder = {
        where: () => builder,
        andWhere: (_, params) => {
          if (params?.sourceNow) sourceNow = params.sourceNow;
          return builder;
        },
        orderBy: () => builder,
        addOrderBy: () => builder,
        take: () => builder,
        getMany: async () => state.discover,
        getOne: async () =>
          (sourceNow && (!state.row.remote.sourceSync?.readyAt || state.row.remote.sourceSync.readyAt > sourceNow)) ||
          (state.row.remote.sourceSync?.nextAttemptAt &&
            Date.parse(state.row.remote.sourceSync.nextAttemptAt) > Date.now())
            ? null
            : state.row
      };
      return builder;
    }
  };
  service.connection = {
    getRepository: entity =>
      entity === SubmissionEntity
        ? submissionRepository
        : {
            findOneBy: async () => state.account,
            createQueryBuilder: () => {
              const builder = { where: () => builder, andWhere: () => builder, getCount: async () => state.due };
              return builder;
            }
          }
  };
  service.config = { config: { remoteJudge: { enabled: true } } };
  const leases = new Map();
  service.redis = {
    getSharedClient: () => ({
      set: async (key, value, _, ttl, nx) => {
        if (nx === "NX" && leases.has(key)) return null;
        leases.set(key, { value, until: Date.now() + ttl });
        return "OK";
      },
      pttl: async key => (leases.has(key) ? Math.max(0, leases.get(key).until - Date.now()) : 0),
      eval: async (_, __, key, token) => {
        state.released++;
        if (leases.get(key)?.value === token) leases.delete(key);
      }
    })
  };
  service.locks = { lock: async (_, fn) => fn() };
  service.provider = {
    getAtcoderSessionContext: async accountId => ({
      accountId,
      session: state.session ? "private-session" : undefined,
      cooldownMs: state.cooldown || 0
    }),
    getAtcoderSource: async (expected, accountId, context) => {
      state.fetches++;
      assert.deepEqual(expected, identity);
      assert.equal(accountId, state.account.id);
      assert.equal(context.accountId, accountId);
      assert.equal(context.session, "private-session");
      if (state.error) throw new Error(state.error);
      return source;
    }
  };
  service.users = { findUserById: async () => ({ id: 1, isActive: state.active }) };
  service.problems = {
    lockProblemById: async (_, __, fn) => fn(state.problem),
    userHasPermission: async () => state.allowed
  };
  service.contests = {
    getContestAccessRestriction: async () => state.restricted,
    findContestById: async () => state.contest,
    userHasPermission: async () => state.allowed
  };
  service.submissions = {
    saveRemoteSource: async (expected, code) => {
      state.saves++;
      assert.equal(expected.id, row.id);
      assert.equal(code, source);
      state.row.remote.sourceSync = { status: "Available", failures: 0 };
      state.row.remote.sourceAvailable = true;
    }
  };
  return { service, state };
}

test("final submissions are immediately eligible and old one-minute source delays are removed", async t => {
  const now = Date.parse("2026-10-23T04:00:00Z");
  t.mock.method(Date, "now", () => now);
  for (const age of [10000, 3600000]) {
    const { service, state } = fixture();
    state.row.submitTime = new Date(now - age);
    state.row.remote.submittedAt = (now - age) / 1000;
    state.row.remote.sourceSync = {
      status: "Pending",
      failures: 0,
      readyAt: new Date(now + 60000).toISOString(),
      nextAttemptAt: new Date(now + 60000).toISOString()
    };
    state.discover = [structuredClone(state.row)];
    await service.tick();
    assert.equal(state.fetches, 1);
    assert.equal(state.saves, 1);
  }
});

test("legacy source discovery makes final submissions eligible immediately", async t => {
  const now = Date.parse("2026-10-23T04:00:00Z");
  t.mock.method(Date, "now", () => now);
  const { service, state } = fixture();
  delete state.row.remote.sourceSync;
  state.discover = [structuredClone(state.row)];
  await service.discover();
  assert.equal(Date.parse(state.row.remote.sourceSync.nextAttemptAt), now);
  await service.process(state.row);
  assert.equal(state.fetches, 1);
});

test("upgrading a failed source job removes the artificial delay while preserving its longer failure backoff", async t => {
  const now = Date.parse("2026-10-23T04:00:00Z");
  t.mock.method(Date, "now", () => now);
  const { service, state } = fixture();
  state.row.remote.sourceSync = {
    status: "Failed",
    failures: 3,
    error: "REMOTE_RATE_LIMITED",
    nextAttemptAt: new Date(now + 120000).toISOString()
  };
  state.discover = [structuredClone(state.row)];
  await service.tick();
  assert.equal(state.row.remote.sourceSync.readyAt, new Date(now).toISOString());
  assert.equal(state.row.remote.sourceSync.nextAttemptAt, new Date(now + 120000).toISOString());
  assert.equal(state.row.remote.sourceSync.failures, 3);
  const saved = structuredClone(state.row.remote.sourceSync);
  await service.tick();
  assert.deepEqual(state.row.remote.sourceSync, saved);
  assert.equal(state.fetches, 0);
});

test("source jobs resume from persisted rows, yield to grades, pause without a session and skip already saved code", async () => {
  const { service, state } = fixture();
  state.session = false;
  await service.tick();
  assert.equal(state.fetches, 0);
  state.session = true;
  state.row.remote.sourceSync.nextAttemptAt = new Date(0).toISOString();
  state.due = 1;
  await service.tick();
  assert.equal(state.fetches, 0);
  state.due = 0;
  await service.tick();
  assert.equal(state.fetches, 1);
  assert.equal(state.saves, 1);
  await service.tick();
  assert.equal(state.fetches, 1);
  assert.equal(state.released, 4);
  service.config.config.remoteJudge.enabled = false;
  await service.tick();
  assert.equal(state.released, 4);
});

test("source failures are persisted with exponential backoff, without mutating the imported result", async () => {
  const { service, state } = fixture();
  state.error = "REMOTE_RATE_LIMITED";
  const result = structuredClone(state.row.remote);
  for (let attempt = 1; attempt <= 3; attempt++) {
    state.row.remote.sourceSync.nextAttemptAt = new Date(0).toISOString();
    const started = Date.now();
    await service.process(state.row);
    assert.equal(state.row.remote.sourceSync.failures, attempt);
    assert.equal(state.row.remote.sourceSync.status, "Failed");
    assert.equal(state.row.remote.sourceSync.error, state.error);
    assert.equal(state.row.remote.sourceSync.readyAt, result.sourceSync.readyAt);
    const delay = Date.parse(state.row.remote.sourceSync.nextAttemptAt) - started;
    assert.ok(delay >= 60000 * 2 ** (attempt - 1) && delay < 60000 * 2 ** (attempt - 1) + 2000);
  }
  const { sourceSync: ignoredQueue, ...actualResult } = state.row.remote;
  const { sourceSync: originalQueue, ...expectedResult } = result;
  assert.deepEqual(actualResult, expectedResult);
  assert.equal(state.row.status, Status.Accepted);
  assert.equal(state.saves, 0);
  const fetches = state.fetches;
  await service.process(state.row);
  assert.equal(state.fetches, fetches, "a stale worker must respect another worker's persisted cooldown");
  delete state.error;
  state.row.remote.sourceSync.nextAttemptAt = new Date(0).toISOString();
  await service.process(state.row);
  assert.equal(state.row.remote.sourceSync.status, "Available");
});

test("concurrent workers share one claim and source rate limits pause other jobs", async () => {
  const { service, state } = fixture();
  await Promise.all([service.tick(), service.tick()]);
  assert.equal(state.fetches, 1);
  assert.equal(state.saves, 1);
  assert.equal(state.released, 1);

  const limited = fixture();
  limited.state.error = "REMOTE_RATE_LIMITED";
  await limited.service.tick();
  assert.equal(limited.state.fetches, 1);
  await limited.service.tick();
  assert.equal(limited.state.fetches, 1, "shared cooldown must cover other due source jobs too");
});

test("source fetch rechecks binding, current task mapping, active users and contest access", async () => {
  for (const change of [
    state => {
      state.account = null;
    },
    state => {
      state.account.handleKey = "someone";
    },
    state => {
      state.row.submitterId = 2;
    },
    state => {
      state.active = false;
    },
    state => {
      state.problem.remoteProblem.taskId = "abc001_2";
    },
    state => {
      state.allowed = false;
    },
    state => {
      state.restricted = [{ id: 5 }];
    },
    state => {
      state.row.contestId = 5;
      state.row.contestProblemIndex = 1;
      state.contest = { id: 5, problemIds: [8] };
    }
  ]) {
    const { service, state } = fixture();
    change(state);
    await service.process(state.row);
    assert.equal(state.fetches, 0);
    assert.equal(state.row.remote.sourceSync.status, "Failed");
  }
  const { service, state } = fixture();
  state.row.contestId = 5;
  state.row.contestProblemIndex = 1;
  state.contest = { id: 5, problemIds: [7] };
  state.restricted = [{ id: 5 }];
  await service.process(state.row);
  assert.equal(state.saves, 1);
});

test("legacy discovery merges queue state into the latest remote JSON without replacing a concurrent result or retry", async () => {
  const { service, state } = fixture();
  delete state.row.remote.sourceSync;
  state.discover = [structuredClone(state.row)];
  state.row.remote.verdict = "AC";
  await service.discover();
  assert.equal(state.updates.length, 1);
  assert.equal(state.updates[0].where.id, 9);
  assert.equal(state.updates[0].update.remote.sourceSync.status, "Pending");
  assert.equal(state.row.remote.verdict, "AC");
  state.row.remote.sourceSync = {
    status: "Failed",
    failures: 3,
    readyAt: state.row.remote.sourceSync.readyAt,
    error: "REMOTE_RATE_LIMITED",
    nextAttemptAt: new Date(Date.now() + 600000).toISOString()
  };
  const before = structuredClone(state.row);
  await service.discover();
  assert.equal(state.updates.length, 1);
  assert.deepEqual(state.row, before);
});

test("shared result cooldown pauses source work without incrementing submission failures", async () => {
  const { service, state } = fixture();
  state.cooldown = 60000;
  await service.tick();
  assert.equal(state.fetches, 0);
  state.cooldown = 0;
  state.row.remote.sourceSync.nextAttemptAt = new Date(0).toISOString();
  state.error = "REMOTE_COOLDOWN";
  await service.tick();
  assert.notEqual(state.row.remote.sourceSync?.status, "Failed");
  state.error = null;
  await service.tick();
  assert.equal(state.saves, 1);
});
