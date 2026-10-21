const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
require("reflect-metadata");
require("tsconfig-paths").register({ baseUrl: path.resolve(__dirname, "../dist"), paths: { "@/*": ["*"] } });
const { validate } = require("class-validator");
const { plainToInstance } = require("class-transformer");
const {
  parseRemoteProblem,
  remoteVerdict,
  remoteCodeLanguage,
  SubmissionMethod: Method
} = require("../dist/remote-judge/remote-judge.types");
const { RemoteProviderService } = require("../dist/remote-judge/remote-provider.service");
const { RemoteJudgeService } = require("../dist/remote-judge/remote-judge.service");
const { RemotePlatformDto, SetSubmissionMethodDto } = require("../dist/remote-judge/remote-judge.dto");
const { RemoteAccountEntity } = require("../dist/remote-judge/remote-account.entity");
const { RemoteWatchEntity } = require("../dist/remote-judge/remote-watch.entity");
const { SubmissionService } = require("../dist/submission/submission.service");
const { SubmissionEntity, ContestSubmissionPhase } = require("../dist/submission/submission.entity");
const { SubmissionDetailEntity } = require("../dist/submission/submission-detail.entity");
const { ProblemEntity, ProblemType } = require("../dist/problem/problem.entity");
const { ProblemFileEntity } = require("../dist/problem/problem-file.entity");
const { ProblemService } = require("../dist/problem/problem.service");
const { SubmissionStatus: Status } = require("../dist/submission/submission-status.enum");

function locks() {
  const jobs = new Map();
  return {
    async lock(key, fn) {
      const previous = jobs.get(key) || Promise.resolve();
      let release;
      const current = new Promise(resolve => {
        release = resolve;
      });
      jobs.set(key, current);
      await previous;
      try {
        return await fn();
      } finally {
        release();
        if (jobs.get(key) === current) jobs.delete(key);
      }
    }
  };
}

const remote = (overrides = {}) => ({
  id: "101",
  platform: Method.Codeforces,
  handle: "coder",
  contestId: "4",
  taskId: "A",
  submittedAt: 1700000000,
  verdict: "OK",
  status: Status.Accepted,
  language: "GNU C++20",
  time: 31,
  memory: 4096,
  url: "https://codeforces.com/contest/4/submission/101",
  historical: false,
  ...overrides
});
const problem = () => ({
  id: 7,
  type: ProblemType.Traditional,
  submissionMethod: Method.Codeforces,
  isPublic: true,
  remoteProblem: parseRemoteProblem(Method.Codeforces, "https://codeforces.com/problemset/problem/4/A")
});

test("source parser uses exact HTTPS hosts, preserves actual AtCoder task IDs and rejects arbitrary URLs", () => {
  assert.deepEqual(parseRemoteProblem(Method.Codeforces, "https://codeforces.com/contest/4/problem/a"), {
    contestId: "4",
    taskId: "A",
    url: "https://codeforces.com/problemset/problem/4/A"
  });
  assert.equal(
    parseRemoteProblem(Method.AtCoder, "https://atcoder.jp/contests/abc001/tasks/abc001_1?lang=en").taskId,
    "abc001_1"
  );
  assert.equal(parseRemoteProblem(Method.Local), null);
  for (const url of [
    "http://codeforces.com/problemset/problem/4/A",
    "https://codeforces.com.evil.test/problemset/problem/4/A",
    "https://user@codeforces.com/problemset/problem/4/A",
    "https://codeforces.com:8443/problemset/problem/4/A",
    "https://127.0.0.1/",
    "https://codeforces.com/blog/entry/4",
    "https://atcoder.jp/contests/abc001/tasks/abc001_1"
  ])
    assert.throws(() => parseRemoteProblem(Method.Codeforces, url), /INVALID_REMOTE_URL/);
});

test("binding DTO does not permit a Local platform; source configuration validates partial score denominator", async () => {
  assert.ok((await validate(plainToInstance(RemotePlatformDto, { platform: Method.Local }))).length);
  assert.equal((await validate(plainToInstance(RemotePlatformDto, { platform: Method.AtCoder }))).length, 0);
  assert.ok(
    (
      await validate(
        plainToInstance(SetSubmissionMethodDto, {
          problemId: 1,
          submissionMethod: Method.AtCoder,
          remoteFullScore: 0
        })
      )
    ).length
  );
});

test("verdict mapping preserves pending, failures and unknown final statuses", () => {
  assert.equal(remoteVerdict(Method.Codeforces, "OK"), Status.Accepted);
  assert.equal(remoteVerdict(Method.Codeforces, "COMPILATION_ERROR"), Status.CompilationError);
  assert.equal(remoteVerdict(Method.Codeforces, undefined), Status.Pending);
  assert.equal(remoteVerdict(Method.Codeforces, "TESTING"), Status.Pending);
  assert.equal(remoteVerdict(Method.AtCoder, "3/20"), Status.Pending);
  assert.equal(remoteVerdict(Method.AtCoder, "WJ"), Status.Pending);
  assert.equal(remoteVerdict(Method.AtCoder, "MLE"), Status.MemoryLimitExceeded);
  assert.equal(remoteVerdict(Method.AtCoder, "NEW_UNKNOWN_VERDICT"), Status.JudgementFailed);
});

test("CF paginates history, retains pending submissions behind the cursor and filters other accounts", async () => {
  const provider = Object.create(RemoteProviderService.prototype);
  const row = id => ({
    id,
    creationTimeSeconds: 1700000000 + id,
    problem: { contestId: 4, index: "A" },
    author: { members: [{ handle: "Coder" }] },
    verdict: "OK",
    programmingLanguage: "GNU C++20",
    timeConsumedMillis: 3,
    memoryConsumedBytes: 1024
  });
  const requests = [];
  provider.codeforces = async (_, params) => {
    requests.push(params.from);
    return params.from === "1"
      ? Array.from({ length: 100 }, (_, i) => row(200 - i))
      : [{ ...row(100), verdict: "TESTING" }, row(99), { ...row(98), author: { members: [{ handle: "somebody" }] } }];
  };
  const account = { platform: Method.Codeforces, handle: "coder", cursor: "0", scan: null };
  const first = await provider.getPage(account);
  assert.equal(first.more, true);
  assert.equal(first.cursor, "0");
  const last = await provider.getPage({ ...account, scan: first.scan });
  assert.deepEqual(requests, ["1", "101"]);
  assert.equal(last.cursor, "99");
  assert.equal(last.pending, true);
  assert.equal(last.scan, null);
  assert.equal(last.submissions.length, 2);
});

test("ownership proof reads only the exact profile field", async () => {
  const provider = Object.create(RemoteProviderService.prototype);
  provider.codeforces = async () => [{ handle: "Coder", organization: "NSOJ-secret" }];
  assert.equal(await provider.verifyProfile(Method.Codeforces, "coder", "NSOJ-secret"), true);
  assert.equal(await provider.verifyProfile(Method.Codeforces, "someone", "NSOJ-secret"), false);
  provider.request = async () => "<p>NSOJ-secret</p><table><tr><th>Affiliation</th><td>wrong</td></tr></table>";
  assert.equal(await provider.verifyProfile(Method.AtCoder, "coder", "NSOJ-secret"), false);
  provider.request = async () => "<table><tr><th>Affiliation</th><td> NSOJ-secret </td></tr></table>";
  assert.equal(await provider.verifyProfile(Method.AtCoder, "coder", "NSOJ-secret"), true);
});

function submissionFixture() {
  const service = Object.create(SubmissionService.prototype);
  const stored = new Map(),
    details = new Map();
  const emitted = [];
  let nextId = 1;
  const counts = { submissions: 0, userSubmissions: 0, accepted: 0, userAccepted: 0, review: 0, events: 0, contest: 0 };
  const save = async item => {
    if (item instanceof SubmissionEntity) {
      if (!item.id) item.id = nextId++;
      stored.set(item.id, structuredClone(item));
    } else if (item instanceof SubmissionDetailEntity) details.set(item.submissionId, structuredClone(item));
    return item;
  };
  service.lockService = locks();
  service.connection = {
    transaction: async (...args) =>
      args.at(-1)({
        save,
        increment: async (entity, _, field) => {
          if (entity === ProblemEntity && field === "submissionCount") counts.submissions++;
          if (entity !== ProblemEntity && field === "submissionCount") counts.userSubmissions++;
        }
      })
  };
  service.submissionRepository = {
    findOneBy: async where => {
      const item = [...stored.values()].find(row => Object.entries(where).every(([key, value]) => row[key] === value));
      return item ? Object.assign(new SubmissionEntity(), structuredClone(item)) : null;
    }
  };
  service.submissionDetailRepository = {
    findOneBy: async where =>
      Object.assign(new SubmissionDetailEntity(), structuredClone(details.get(where.submissionId)))
  };
  service.problemService = {
    updateProblemStatistics: async (_, __, accepted) => {
      counts.accepted += accepted;
    }
  };
  service.userService = {
    updateUserAcceptedCount: async (_, __, transition) => {
      counts.userAccepted += transition === "NON_AC_TO_AC" ? 1 : -1;
      return true;
    }
  };
  service.submissionStatisticsService = { onSubmissionUpdated: async () => {} };
  service.contestService = { onSubmissionUpdated: async () => counts.contest++ };
  service.problemReviewService = { onAcceptedSubmission: async () => counts.review++ };
  service.metricSubmissionJudgeTime = { observe() {} };
  service.problemTypeFactoryService = {
    type: () => ({ getTimeAndMemoryUsedFromFinishedSubmissionProgress: () => ({ timeUsed: 0, memoryUsed: 0 }) })
  };
  service.submissionProgressService = {
    emitSubmissionEvent: async (_, __, progress) => {
      counts.events++;
      emitted.push(progress);
    }
  };
  return { service, stored, details, counts, emitted };
}

test("concurrent and repeated sync creates one real submission, with original timestamp and resource usage", async () => {
  const { service, stored, details, counts } = submissionFixture();
  await Promise.all(Array.from({ length: 4 }, () => service.importRemoteSubmission({ id: 1 }, problem(), remote())));
  assert.equal(stored.size, 1);
  const saved = [...stored.values()][0];
  assert.equal(+saved.submitTime, 1700000000000);
  assert.equal(saved.timeUsed, 31);
  assert.equal(saved.memoryUsed, 4);
  assert.equal(saved.remote.memory, 4096);
  assert.equal(saved.score, 100);
  assert.equal(saved.taskId, null);
  assert.equal(details.get(saved.id).result.progressType, "Finished");
  assert.deepEqual(counts, {
    submissions: 1,
    userSubmissions: 1,
    accepted: 1,
    userAccepted: 1,
    review: 1,
    events: 1,
    contest: 0
  });
  await service.importRemoteSubmission({ id: 2 }, problem(), remote());
  assert.equal([...stored.values()][0].submitterId, 1);
  assert.equal(stored.size, 1);
});

test("pending becomes final once; historical results update live pages without review or celebration", async () => {
  const { service, stored, counts, emitted } = submissionFixture();
  await service.importRemoteSubmission(
    { id: 1 },
    problem(),
    remote({ status: Status.Pending, verdict: "TESTING", historical: true })
  );
  assert.equal(counts.accepted, 0);
  await service.importRemoteSubmission({ id: 1 }, problem(), remote({ historical: true }));
  assert.equal(stored.size, 1);
  assert.equal(counts.accepted, 1);
  assert.equal(counts.review, 0);
  assert.equal(counts.events, 1);
  assert.equal(emitted[0].isFirstAccepted, false);
});

test("a lagging history index cannot overwrite an original-site verdict across sync turns", async () => {
  const { service, stored } = submissionFixture();
  await service.importRemoteSubmission({ id: 1 }, problem(), remote({ resultSource: "AtCoderProblems" }));
  await service.importRemoteSubmission({ id: 1 }, problem(), remote({ resultSource: "OriginalSite" }));
  assert.equal(stored.values().next().value.remote.resultSource, "OriginalSite");
  await service.importRemoteSubmission(
    { id: 1 },
    problem(),
    remote({
      resultSource: "AtCoderProblems",
      verdict: "WA",
      status: Status.WrongAnswer
    })
  );
  assert.equal(stored.values().next().value.status, Status.Accepted);
});

test("contest records use the ordinary submission table without duplicate practice records", async () => {
  const { service, stored, counts } = submissionFixture();
  await service.importRemoteSubmission({ id: 1 }, problem(), remote(), {
    id: 20,
    problemIndex: 2,
    phase: ContestSubmissionPhase.Official
  });
  await service.importRemoteSubmission({ id: 1 }, problem(), remote());
  assert.equal(stored.size, 1);
  assert.equal([...stored.values()][0].contestId, 20);
  assert.equal(counts.submissions, 1);
  assert.equal(counts.contest, 1);
});

test("partial scores are normalized only using configured original maximum", async () => {
  const { service, stored } = submissionFixture();
  const target = problem();
  target.remoteProblem.fullScore = 400;
  await service.importRemoteSubmission(
    { id: 1 },
    target,
    remote({ status: Status.PartiallyCorrect, verdict: "PARTIAL", points: 150 })
  );
  assert.equal([...stored.values()][0].score, 38);
});

test("remote files and direct local submissions are rejected on the server", async () => {
  const service = Object.create(ProblemService.prototype);
  assert.throws(() => service.assertLocalFiles(problem()), /REMOTE_FILES_DISABLED/);
  assert.doesNotThrow(() => service.assertLocalFiles({ submissionMethod: Method.Local }));
  assert.deepEqual(await service.getProblemFiles(problem(), "TestData"), []);
  assert.deepEqual(await service.listProblemFiles(problem(), "AdditionalFile"), []);
  await assert.rejects(
    Object.create(SubmissionService.prototype).createSubmission({ id: 1 }, problem(), {}, null),
    /USE_REMOTE_SUBMISSION/
  );
});

test("switching requires modify permission, empty files and no pending submissions", async () => {
  const service = Object.create(RemoteJudgeService.prototype);
  let permission = false,
    files = 0,
    pending = 0,
    updates = 0;
  service.audit = { log: async () => {} };
  service.problems = {
    findProblemById: async () => problem(),
    userHasPermission: async () => permission,
    lockProblemById: async (_, __, callback) => callback(problem())
  };
  service.connection = {
    getRepository: entity => ({ countBy: async () => (entity === ProblemFileEntity ? files : pending) }),
    transaction: async callback =>
      callback({
        delete: async () => {},
        update: async () => {
          updates++;
        }
      })
  };
  const request = {
    problemId: 7,
    submissionMethod: Method.AtCoder,
    remoteUrl: "https://atcoder.jp/contests/abc001/tasks/abc001_1"
  };
  await assert.rejects(service.setMethod({ id: 1 }, request), /Forbidden/);
  permission = true;
  files = 1;
  await assert.rejects(service.setMethod({ id: 1 }, request), /REMOVE_FILES_FIRST/);
  files = 0;
  pending = 1;
  await assert.rejects(service.setMethod({ id: 1 }, request), /PENDING_SUBMISSIONS/);
  pending = 0;
  await service.setMethod({ id: 1 }, request);
  assert.equal(updates, 1);
});

test("contest context selects by original time, checks membership and rejects historical AC", async () => {
  const service = Object.create(RemoteJudgeService.prototype);
  const imported = [];
  service.problems = {
    lockProblemById: async (_, __, callback) => callback(problem()),
    getProblemJudgeInfo: async () => [{}, true],
    userHasPermission: async () => true
  };
  service.contests = {
    getContestAccessRestriction: async () => [],
    findContestById: async id => ({ id, problemIds: [7] }),
    userHasPermission: async () => true,
    getSubmissionPhase: (_, date) => (+date >= 1700000000000 && +date < 1700000100000 ? "official" : null)
  };
  service.submissions = { importRemoteSubmission: async (_, __, ___, context) => imported.push(context) };
  const account = { platform: Method.Codeforces, handle: "coder", verifiedAt: new Date(1690000000000) };
  const watches = [
    {
      id: 1,
      problemId: 7,
      contestId: 20,
      contestProblemIndex: 1,
      startedAt: new Date(1700000000000),
      until: new Date(1700000100000)
    }
  ];
  await service.importResult(account, { id: 1 }, remote({ submittedAt: 1700000050 }), [problem()], watches);
  assert.equal(imported.pop().id, 20);
  await service.importResult(account, { id: 1 }, remote({ submittedAt: 1699999900 }), [problem()], watches);
  assert.equal(imported.pop(), undefined);
  service.contests.userHasPermission = async () => false;
  service.problems.userHasPermission = async () => false;
  await service.importResult(account, { id: 1 }, remote({ submittedAt: 1700000050 }), [problem()], watches);
  assert.equal(imported.length, 0);
});

test("binding proof fits the 30-character profile limit and verifies unchanged on both platforms", async () => {
  for (const platform of [Method.Codeforces, Method.AtCoder]) {
    const service = Object.create(RemoteJudgeService.prototype);
    const pending = new Map();
    const saved = [];
    service.lockService = locks();
    service.configService = { config: {} };
    service.redisService = {
      getClient: () => ({
        set: async (key, value, mode, seconds) => {
          if (key === `remote-bind:1:${platform}`) {
            assert.equal(mode, "EX");
            assert.equal(seconds, 900);
          }
          pending.set(key, value);
          return "OK";
        },
        get: async key => pending.get(key) ?? null,
        del: async key => pending.delete(key)
      })
    };
    service.accounts = {
      findOneBy: async () => undefined,
      findBy: async () => saved,
      create: value => value,
      save: async value => saved.push(value)
    };
    const { code, expiresIn } = await service.beginBinding({ id: 1 }, { platform, handle: "Coder" });
    assert.ok(code.length <= 30, `Profile proof is too long: ${code.length}`);
    assert.match(code, /^NSOJ-[A-Za-z0-9_-]+$/);
    assert.equal(expiresIn, 900);
    assert.deepEqual(JSON.parse(pending.get(`remote-bind:1:${platform}`)), { handle: "Coder", code });

    const provider = Object.create(RemoteProviderService.prototype);
    provider.codeforces = async () => [{ handle: "Coder", organization: code }];
    provider.request = async () => `<table><tr><th>Affiliation</th><td>${code}</td></tr></table>`;
    service.provider = provider;
    await service.verifyBinding({ id: 1 }, platform);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].platform, platform);
    assert.equal(saved[0].handle, "Coder");
    assert.equal(pending.has(`remote-bind:1:${platform}`), false);
  }
});

test("two users cannot bind the same remote handle with different capitalization", async () => {
  const service = Object.create(RemoteJudgeService.prototype);
  const stored = [];
  service.lockService = locks();
  service.configService = { config: {} };
  service.provider = { verifyProfile: async () => true };
  service.redisService = {
    getClient: () => ({
      get: async key => JSON.stringify({ handle: key.includes(":1:") ? "Coder" : "coder", code: "secret" }),
      set: async () => "OK",
      del: async () => {}
    })
  };
  service.accounts = {
    findOneBy: async where => stored.find(row => Object.entries(where).every(([key, value]) => row[key] === value)),
    findBy: async where => stored.filter(row => row.userId === where.userId),
    create: value => value,
    save: async value => {
      stored.push({ id: stored.length + 1, ...value });
    }
  };
  const results = await Promise.allSettled([
    service.verifyBinding({ id: 1 }, Method.Codeforces),
    service.verifyBinding({ id: 2 }, Method.Codeforces)
  ]);
  assert.equal(results.filter(item => item.status === "fulfilled").length, 1);
  assert.equal(stored.length, 1);
  assert.match(results.find(item => item.status === "rejected").reason.message, /ACCOUNT_ALREADY_BOUND/);
});

test("returning to a problem extends activity without bypassing cooldown or repeating its history reset", async () => {
  const service = Object.create(RemoteJudgeService.prototype);
  const nextSyncAt = new Date(Date.now() + 60000);
  const account = {
    id: 1,
    userId: 1,
    platform: Method.Codeforces,
    handle: "coder",
    cursor: "900",
    scan: null,
    nextSyncAt
  };
  let watch;
  service.lockService = locks();
  service.configService = { config: {} };
  service.context = async () => ({ problem: problem() });
  service.problems = { getProblemJudgeInfo: async () => [{}, true] };
  service.accounts = {
    findOneBy: async () => account,
    findBy: async () => [account],
    update: async (_, value) => Object.assign(account, value)
  };
  service.watches = {
    findOne: async () => watch,
    create: value => value,
    save: async value => {
      watch = { id: 1, ...value };
    },
    update: async (_, value) => Object.assign(watch, value)
  };
  await service.activate({ id: 1 }, { problemId: 7 });
  assert.equal(account.cursor, "0");
  account.cursor = "950";
  await service.activate({ id: 1 }, { problemId: 7 });
  assert.equal(account.cursor, "950");
  assert.equal(account.nextSyncAt, nextSyncAt);
  assert.ok(account.activeUntil > new Date());
});

function workerFixture(candidate) {
  const service = Object.create(RemoteJudgeService.prototype);
  const updates = [],
    filters = [];
  let requests = 0;
  service.configService = { config: {} };
  service.accounts = {
    createQueryBuilder: () => {
      const builder = {
        where: sql => {
          filters.push(sql);
          return builder;
        },
        orderBy: () => builder,
        getOne: async () => candidate
      };
      return builder;
    },
    findOneBy: async () => candidate,
    update: async (_, value) => {
      updates.push(value);
      Object.assign(candidate, value);
    }
  };
  service.redisService = { getClient: () => ({ set: async () => "OK", eval: async () => 1 }) };
  service.lockService = locks();
  service.users = { findUserById: async () => ({ id: 1, isActive: true }) };
  service.provider = {
    getPage: async () => {
      requests++;
      throw new Error("REMOTE_UNAVAILABLE");
    }
  };
  return { service, updates, filters, requestCount: () => requests };
}

test("idle accounts are excluded before any upstream query and paused sync never starts a request", async () => {
  const idle = workerFixture(null);
  await idle.service.tick(Method.Codeforces);
  assert.equal(idle.requestCount(), 0);
  assert.match(idle.filters[0], /activeUntil > :now/);
  const paused = workerFixture({ id: 1, nextSyncAt: new Date(0) });
  paused.service.configService.config.remoteJudge = { enabled: false };
  await paused.service.tick(Method.Codeforces);
  assert.equal(paused.requestCount(), 0);
});

test("upstream failure backs off without advancing the submission cursor", async () => {
  const account = { id: 1, userId: 1, nextSyncAt: new Date(0), cursor: "900", failures: 0 };
  const fixture = workerFixture(account);
  const start = Date.now();
  await fixture.service.tick(Method.Codeforces);
  assert.equal(account.cursor, "900");
  assert.equal(account.failures, 1);
  assert.equal(account.lastError, "REMOTE_UNAVAILABLE");
  assert.ok(+account.nextSyncAt >= start + 60000);
});

test("AtCoder pauses without a session and resumes immediately after one is configured", async () => {
  const account = { id: 1, userId: 1, nextSyncAt: new Date(0), cursor: "900", failures: 0, catchUpRequested: true };
  const { service, updates, requestCount } = workerFixture(account);
  service.provider.hasAtcoderDirectSession = async () => false;
  await service.tick(Method.AtCoder);
  assert.equal(requestCount(), 0);
  assert.deepEqual(updates, []);
  assert.equal(+account.nextSyncAt, 0);
  assert.equal(account.lastSyncedAt, undefined);
  service.provider.hasAtcoderDirectSession = async () => true;
  service.watches = { findBy: async () => [] };
  service.provider.getPage = async (_, targets) => {
    assert.deepEqual(targets, []);
    return { submissions: [], cursor: account.cursor, scan: null, more: false, pending: false };
  };
  await service.tick(Method.AtCoder);
  assert.ok(account.lastSyncedAt instanceof Date);
  assert.equal(account.lastError, null);
});

test("AtCoder account status does not claim third-party historical import is running", async () => {
  const service = Object.create(RemoteJudgeService.prototype);
  service.configService = { config: {} };
  service.accounts = {
    findBy: async () =>
      [Method.AtCoder, Method.Codeforces].map(platform => ({
        platform,
        cursor: "0",
        scan: null,
        catchUpRequested: true
      }))
  };
  const { accounts } = await service.list({ id: 1 });
  assert.equal(accounts[0].importingHistory, false);
  assert.equal(accounts[1].importingHistory, true);
});

test("failed or paused CF history scans do not claim import is running", async () => {
  const service = Object.create(RemoteJudgeService.prototype);
  service.configService = { config: {} };
  const account = { platform: Method.Codeforces, cursor: "0", scan: { offset: 101 }, catchUpRequested: true };
  service.accounts = { findBy: async () => [account] };
  assert.equal((await service.list({ id: 1 })).accounts[0].importingHistory, true);
  account.lastError = "REMOTE_UNAVAILABLE";
  assert.equal((await service.list({ id: 1 })).accounts[0].importingHistory, false);
  account.lastError = null;
  service.configService.config = { remoteJudge: { enabled: false } };
  assert.equal((await service.list({ id: 1 })).accounts[0].importingHistory, false);
});

test("direct sync only queries recent watched contests and commits its checkpoint after imports", async () => {
  const account = { id: 1, userId: 1, nextSyncAt: new Date(0), cursor: "900", failures: 0 };
  const { service } = workerFixture(account);
  const now = Date.now();
  service.watches = {
    findBy: async () => [
      { problemId: 7, startedAt: new Date(now - 60000), until: new Date(now + 60000) },
      { problemId: 8, startedAt: new Date(now - 90000), until: new Date(now + 60000) },
      { problemId: 9, startedAt: new Date(now - 3 * 86400000), until: new Date(now - 2 * 86400000) }
    ]
  };
  let repositoryReads = 0;
  service.connection = {
    getRepository: () => ({
      findBy: async where => {
        repositoryReads++;
        if (repositoryReads === 1) {
          assert.deepEqual(where.id.value, [7, 8]);
          return [
            { id: 7, remoteProblem: { contestId: "abc480" } },
            { id: 8, remoteProblem: { contestId: "abc480" } }
          ];
        }
        return [problem()];
      }
    })
  };
  service.provider.hasAtcoderDirectSession = async () => true;
  const events = [];
  service.provider.getPage = async (_, liveTargets) => {
    assert.deepEqual(liveTargets, [{ contestId: "abc480", since: Math.floor((now - 90000) / 1000) }]);
    return {
      submissions: [remote()],
      cursor: "950",
      scan: null,
      more: false,
      pending: false,
      acknowledge: async () => events.push("checkpoint")
    };
  };
  service.importResult = async () => events.push("import");
  await service.tick(Method.AtCoder);
  assert.deepEqual(events, ["import", "checkpoint"]);
  assert.equal(account.lastError, null);
  account.nextSyncAt = new Date(0);
  repositoryReads = 0;
  events.length = 0;
  service.importResult = async () => {
    throw new Error("write failed");
  };
  await service.tick(Method.AtCoder);
  assert.deepEqual(events, []);
  assert.equal(account.cursor, "950");
  assert.equal(account.failures, 1);
});

test("ordinary visits request one catch-up without starting continuous tracking", async () => {
  const service = Object.create(RemoteJudgeService.prototype);
  const account = {
    id: 1,
    userId: 1,
    platform: Method.Codeforces,
    cursor: "900",
    catchUpVersion: 0,
    activeUntil: new Date(0),
    nextSyncAt: new Date(Date.now() + 60000)
  };
  const activeUntil = account.activeUntil,
    nextSyncAt = account.nextSyncAt;
  service.configService = { config: {} };
  service.accounts = {
    findBy: async () => [account],
    update: async (_, value) => {
      const { catchUpVersion, ...rest } = value;
      Object.assign(account, rest);
      if (catchUpVersion) account.catchUpVersion++;
    }
  };
  await service.activate({ id: 1 }, {});
  assert.equal(account.catchUpRequested, true);
  assert.equal(account.catchUpVersion, 1);
  assert.equal(account.activeUntil, activeUntil);
  assert.equal(account.nextSyncAt, nextSyncAt);
});

test("one-shot sync stops after success but retains a new request arriving during the upstream call", async () => {
  for (const newRequest of [false, true]) {
    const account = {
      id: 1,
      userId: 1,
      nextSyncAt: new Date(0),
      cursor: "900",
      failures: 0,
      catchUpRequested: true,
      catchUpVersion: 0,
      activeUntil: new Date(0)
    };
    const { service } = workerFixture(account);
    service.accounts.findOneBy = async () => structuredClone(account);
    service.accounts.update = async (_, value) => {
      const resolved = { ...value };
      if (typeof value.catchUpRequested === "function") {
        const expectedVersion = Number(value.catchUpRequested().match(/catchUpVersion = (\d+)/)[1]);
        resolved.catchUpRequested = account.catchUpVersion !== expectedVersion;
      }
      Object.assign(account, resolved);
    };
    service.watches = { findBy: async () => [] };
    service.provider.getPage = async () => {
      if (newRequest) account.catchUpVersion++;
      return { submissions: [], cursor: "950", scan: null, more: false, pending: false };
    };
    await service.tick(Method.Codeforces);
    assert.equal(account.catchUpRequested, newRequest);
    assert.equal(account.cursor, "950");
    assert.equal(+account.activeUntil, 0);
  }
});

test("remote language normalization keeps existing language filters useful", () => {
  assert.equal(remoteCodeLanguage("GNU C++23 (64)"), "cpp");
  assert.equal(remoteCodeLanguage("C (GCC 12.2)"), "c");
  assert.equal(remoteCodeLanguage("PyPy 3.10"), "python");
  assert.equal(remoteCodeLanguage("C# 12 (.NET 8)"), "csharp");
  assert.equal(remoteCodeLanguage("Java 21"), "java");
  assert.equal(remoteCodeLanguage("JavaScript (Node.js 22)"), null);
});

test("switching contest pages retains closed context intervals for delayed results", async () => {
  const service = Object.create(RemoteJudgeService.prototype);
  const account = { id: 1, userId: 1, platform: Method.Codeforces, cursor: "0" };
  const stored = [];
  let contestId = 20;
  service.lockService = locks();
  service.configService = { config: {} };
  service.context = async () => ({
    problem: problem(),
    contest: { id: contestId, endTime: new Date(Date.now() + 60000) }
  });
  service.contests = { isRunning: () => true };
  service.problems = { getProblemJudgeInfo: async () => [{}, true] };
  service.accounts = {
    findOneBy: async () => account,
    findBy: async () => [account],
    update: async (_, value) => Object.assign(account, value)
  };
  service.watches = {
    findOne: async () => stored.at(-1),
    create: value => value,
    save: async value => {
      stored.push({ id: stored.length + 1, ...value });
    },
    update: async (where, value) =>
      Object.assign(
        stored.find(row => row.id === where.id),
        value
      )
  };
  await service.activate({ id: 1 }, { problemId: 7, contestId: 20, contestProblemIndex: 1 });
  contestId = 21;
  await service.activate({ id: 1 }, { problemId: 7, contestId: 21, contestProblemIndex: 1 });
  contestId = 20;
  await service.activate({ id: 1 }, { problemId: 7, contestId: 20, contestProblemIndex: 1 });
  assert.deepEqual(
    stored.map(row => row.contestId),
    [20, 21, 20]
  );
  assert.ok(stored[0].until <= stored[1].startedAt);
  assert.ok(stored[1].until <= stored[2].startedAt);
});

test("delayed submissions are routed by their original context interval", async () => {
  const service = Object.create(RemoteJudgeService.prototype);
  const imported = [];
  service.problems = {
    lockProblemById: async (_, __, callback) => callback(problem()),
    getProblemJudgeInfo: async () => [{}, true],
    userHasPermission: async () => true
  };
  service.contests = {
    getContestAccessRestriction: async () => [],
    findContestById: async id => ({ id, problemIds: [7] }),
    userHasPermission: async () => true,
    getSubmissionPhase: () => "official"
  };
  service.submissions = { importRemoteSubmission: async (_, __, ___, context) => imported.push(context.id) };
  const account = { platform: Method.Codeforces, handle: "coder", verifiedAt: new Date(1690000000000) };
  const watches = [20, 21, 20].map((contestId, index) => ({
    id: index + 1,
    problemId: 7,
    contestId,
    contestProblemIndex: 1,
    startedAt: new Date((1700000000 + index * 100) * 1000),
    until: new Date((1700000100 + index * 100) * 1000)
  }));
  for (const submittedAt of [1700000050, 1700000150, 1700000250])
    await service.importResult(account, { id: 1 }, remote({ submittedAt }), [problem()], watches);
  assert.deepEqual(imported, [20, 21, 20]);
});

test("database metadata keeps existing problems local and remote submission keys nullable and unique", async () => {
  const { DataSource } = require("typeorm");
  const dataSource = new DataSource({
    type: "mysql",
    database: "nsoj_metadata_test",
    entities: [path.resolve(__dirname, "../dist/**/*.entity.js")]
  });
  // Builds and validates entity metadata without opening a database connection or synchronizing a schema.
  await dataSource.buildMetadatas();
  const problems = dataSource.getMetadata(ProblemEntity);
  assert.equal(problems.findColumnWithPropertyName("submissionMethod").default, Method.Local);
  assert.equal(problems.findColumnWithPropertyName("remoteProblemKey").isNullable, true);
  const submissions = dataSource.getMetadata(SubmissionEntity);
  assert.equal(submissions.findColumnWithPropertyName("remoteKey").isNullable, true);
  assert.ok(
    submissions.indices.some(
      index => index.isUnique && index.columns.some(column => column.propertyName === "remoteKey")
    )
  );
  assert.ok(
    dataSource
      .getMetadata(RemoteAccountEntity)
      .indices.some(
        index => index.isUnique && index.columns.map(column => column.propertyName).join(",") === "platform,handleKey"
      )
  );
  assert.equal(dataSource.getMetadata(RemoteWatchEntity).foreignKeys.length, 2);
});
