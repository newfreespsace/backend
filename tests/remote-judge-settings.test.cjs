const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
require("reflect-metadata");
require("tsconfig-paths").register({ baseUrl: path.resolve(__dirname, "../dist"), paths: { "@/*": ["*"] } });
const { AtcoderSessionService, normalizeAtcoderSession } = require("../dist/remote-judge/atcoder-session.service");
const { RemoteJudgeService } = require("../dist/remote-judge/remote-judge.service");
const { RemoteProviderService } = require("../dist/remote-judge/remote-provider.service");
const { SiteSettingController } = require("../dist/site-setting/site-setting.controller");
const { RemoteAccountEntity } = require("../dist/remote-judge/remote-account.entity");
const { getMetadataArgsStorage } = require("typeorm");

function fixture() {
  const accounts = new Map([
    [
      1,
      { id: 1, userId: 11, platform: "AtCoder", handle: "Coder", handleKey: "coder", atcoderSessionConfigured: false }
    ],
    [
      2,
      { id: 2, userId: 22, platform: "AtCoder", handle: "Other", handleKey: "other", atcoderSessionConfigured: false }
    ]
  ]);
  const repository = {
    findOne: async ({ where, select }) => {
      const row = [...accounts.values()].find(row => row.id === where.id && row.platform === where.platform);
      return row ? Object.fromEntries(select.map(key => [key, structuredClone(row[key])])) : undefined;
    },
    findOneBy: async where =>
      [...accounts.values()].find(row => Object.entries(where).every(([key, value]) => row[key] === value)),
    findBy: async where => [...accounts.values()].filter(row => row.userId === where.userId),
    create: value => ({ atcoderSessionConfigured: false, catchUpVersion: 0, ...value }),
    save: async value => {
      if (
        [...accounts.values()].some(
          row => row.platform === value.platform && (row.userId === value.userId || row.handleKey === value.handleKey)
        )
      )
        throw Object.assign(new Error("duplicate"), { code: "ER_DUP_ENTRY" });
      value.id = Math.max(0, ...accounts.keys()) + 1;
      accounts.set(value.id, value);
      return value;
    },
    update: async ({ id }, update) => {
      const row = accounts.get(id);
      for (const [key, value] of Object.entries(update))
        row[key] = typeof value === "function" ? (row[key] || 0) + 1 : value;
    }
  };
  const config = { config: { security: { sessionSecret: "private-test-key" } } };
  const sessions = new AtcoderSessionService(repository, config);
  const service = Object.create(RemoteJudgeService.prototype);
  service.accounts = repository;
  service.configService = config;
  service.atcoderSessions = sessions;
  const pending = new Map();
  service.lockService = {
    lock: async (key, fn) => {
      const previous = pending.get(key) || Promise.resolve();
      let release;
      const ready = new Promise(resolve => {
        release = resolve;
      });
      const tail = previous.then(() => ready);
      pending.set(key, tail);
      await previous;
      try {
        return await fn();
      } finally {
        release();
        if (pending.get(key) === tail) pending.delete(key);
      }
    }
  };
  service.connection = {
    transaction: async callback => {
      const snapshot = structuredClone([...accounts]);
      try {
        return await callback({ getRepository: () => repository });
      } catch (error) {
        accounts.clear();
        for (const [id, row] of snapshot) accounts.set(id, row);
        throw error;
      }
    }
  };
  service.redisService = { getSharedClient: () => ({ set: async () => "OK" }) };
  const checks = [];
  service.provider = {
    identifyAtcoderSession: async (session, id) => {
      checks.push([id, session]);
      return session === "private-two" ? "Other" : session === "private-new" ? "NewCoder" : "Coder";
    }
  };
  return { service, sessions, accounts, config, checks };
}

test("personal sessions are encrypted, hidden from account responses, bound to account identity and clearable", async () => {
  const { service, sessions, accounts, checks } = fixture();
  const response = await service.setAtcoderSession({ id: 11 }, { atcoderSession: "REVEL_SESSION=private-one" });
  assert.deepEqual(checks, [[1, "private-one"]]);
  assert.equal(await sessions.get(1), "private-one");
  assert.equal(response.accounts[0].atcoderSessionConfigured, true);
  assert.doesNotMatch(JSON.stringify(response), /private-one|ciphertext|"iv"|"tag"/);
  assert.doesNotMatch(JSON.stringify(accounts.get(1)), /private-one/);
  const first = accounts.get(1).atcoderSession;
  await service.setAtcoderSession({ id: 11 }, { atcoderSession: "private-one" });
  assert.notDeepEqual(accounts.get(1).atcoderSession, first);
  await service.setAtcoderSession({ id: 22 }, { atcoderSession: "private-two" });
  assert.equal(await sessions.get(1), "private-one");
  assert.equal(await sessions.get(2), "private-two");
  accounts.get(2).atcoderSession = accounts.get(1).atcoderSession;
  await assert.rejects(sessions.get(2), /REMOTE_SESSION_UNREADABLE/);
  await service.setAtcoderSession({ id: 11 }, { clear: true });
  assert.equal(await sessions.get(1), undefined);
  assert.equal(accounts.get(1).atcoderSession, null);
  assert.equal(accounts.get(1).atcoderSessionConfigured, false);
  const column = getMetadataArgsStorage().columns.find(
    col => col.target === RemoteAccountEntity && col.propertyName === "atcoderSession"
  );
  assert.equal(column.options.select, false);
});

test("invalid or mismatched session changes preserve the current credential", async () => {
  const { service, sessions } = fixture();
  await service.setAtcoderSession({ id: 11 }, { atcoderSession: "private-old" });
  for (const value of ["", "bad; other=value", "bad\r\nheader", "bad\x00value", "a".repeat(8193), 123]) {
    assert.equal(normalizeAtcoderSession(value), undefined);
    await assert.rejects(service.setAtcoderSession({ id: 11 }, { atcoderSession: value }), /INVALID_ATCODER_SESSION/);
  }
  await assert.rejects(
    service.setAtcoderSession({ id: 11 }, { clear: true, atcoderSession: "value" }),
    /INVALID_ATCODER_SESSION/
  );
  service.provider.identifyAtcoderSession = async () => "AnotherCoder";
  await assert.rejects(
    service.setAtcoderSession({ id: 11 }, { atcoderSession: "wrong-account" }),
    /REMOTE_SESSION_IDENTITY_MISMATCH/
  );
  assert.equal(await sessions.get(1), "private-old");
});

test("global session routes and environment fallback are absent", async () => {
  assert.equal(SiteSettingController.prototype.getRemoteJudgeSettings, undefined);
  assert.equal(SiteSettingController.prototype.updateRemoteJudgeSettings, undefined);
  const { sessions } = fixture();
  const previous = process.env.NSOJ_ATCODER_SESSION;
  process.env.NSOJ_ATCODER_SESSION = "private-global-must-not-be-used";
  try {
    assert.equal(await sessions.get(1), undefined);
    assert.equal(await sessions.get(undefined), undefined);
  } finally {
    if (previous === undefined) delete process.env.NSOJ_ATCODER_SESSION;
    else process.env.NSOJ_ATCODER_SESSION = previous;
  }
});

test("session identification reads the logged-in handle and requires a logout marker", async () => {
  const provider = Object.create(RemoteProviderService.prototype);
  const calls = [];
  provider.request = async (...args) => {
    calls.push(args);
    return '<script>var userScreenName = "CoDeR";</script><form action="/logout?continue=%2F"></form>';
  };
  assert.equal(await provider.identifyAtcoderSession("private-new", 1), "CoDeR");
  assert.equal(calls[0][4], 1);
  assert.equal(calls[0][5], "private-new");
  provider.request = async () => '<script>var userScreenName = "other";</script><a href="/logout">Sign out</a>';
  assert.equal(await provider.identifyAtcoderSession("other-session", 1), "other");
  provider.request = async () => '<script>var userScreenName = "coder";</script>';
  await assert.rejects(provider.identifyAtcoderSession("expired", 1), /REMOTE_AUTH_REQUIRED/);
});

test("saving a first session creates its binding and encrypted credential together", async () => {
  const { service, sessions, accounts } = fixture();
  const response = await service.setAtcoderSession({ id: 99 }, { atcoderSession: "private-new" });
  const bound = [...accounts.values()].find(account => account.userId === 99);
  assert.equal(bound.handle, "NewCoder");
  assert.equal(bound.handleKey, "newcoder");
  assert.equal(bound.atcoderSessionConfigured, true);
  assert.ok(bound.verifiedAt instanceof Date);
  assert.equal(bound.catchUpRequested, true);
  assert.equal(await sessions.get(bound.id), "private-new");
  assert.deepEqual(
    response.accounts.map(account => account.handle),
    ["NewCoder"]
  );
  assert.doesNotMatch(JSON.stringify(response), /private-new|ciphertext/);
  const verifiedAt = +bound.verifiedAt;
  await service.setAtcoderSession({ id: 99 }, { atcoderSession: "private-new" });
  assert.equal(accounts.size, 3);
  assert.equal(+bound.verifiedAt, verifiedAt);
  await service.setAtcoderSession({ id: 99 }, { clear: true });
  assert.equal(accounts.size, 3);
  assert.equal(bound.handle, "NewCoder");
  assert.equal(await sessions.get(bound.id), undefined);
});

test("conflicting owners, failed verification and transaction failures leave no new binding", async () => {
  const { service, accounts, sessions } = fixture();
  await assert.rejects(
    service.setAtcoderSession({ id: 99 }, { atcoderSession: "private-one" }),
    /ACCOUNT_ALREADY_BOUND/
  );
  assert.equal(accounts.size, 2);
  service.provider.identifyAtcoderSession = async () => {
    throw new Error("REMOTE_AUTH_REQUIRED");
  };
  await assert.rejects(service.setAtcoderSession({ id: 99 }, { atcoderSession: "expired" }), /REMOTE_AUTH_REQUIRED/);
  assert.equal(accounts.size, 2);
  service.provider.identifyAtcoderSession = async () => "NewCoder";
  service.atcoderSessions = {
    encrypt: () => {
      throw new Error("TEST_STORAGE_FAILED");
    }
  };
  await assert.rejects(service.setAtcoderSession({ id: 99 }, { atcoderSession: "private-new" }), /TEST_STORAGE_FAILED/);
  assert.equal(accounts.size, 2);
  assert.equal(await sessions.get(3), undefined);
});

test("simultaneous first-time saves cannot attach one AtCoder identity to two NSOJ users", async () => {
  const { service, accounts } = fixture();
  const outcomes = await Promise.allSettled([
    service.setAtcoderSession({ id: 33 }, { atcoderSession: "private-new" }),
    service.setAtcoderSession({ id: 44 }, { atcoderSession: "private-new" })
  ]);
  assert.equal(outcomes.filter(outcome => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.find(outcome => outcome.status === "rejected").reason.message, "ACCOUNT_ALREADY_BOUND");
  assert.equal([...accounts.values()].filter(account => account.handleKey === "newcoder").length, 1);
});

test("AtCoder profile-code binding is retired and clearing an unbound session is harmless", async () => {
  const { service, accounts } = fixture();
  await assert.rejects(
    service.beginBinding({ id: 99 }, { platform: "AtCoder", handle: "NewCoder" }),
    /ATCODER_SESSION_REQUIRED/
  );
  await assert.rejects(service.verifyBinding({ id: 99 }, "AtCoder"), /ATCODER_SESSION_REQUIRED/);
  assert.deepEqual((await service.setAtcoderSession({ id: 99 }, { clear: true })).accounts, []);
  assert.equal(accounts.size, 2);
});
