const assert = require("node:assert/strict");
const { test, beforeEach, afterEach } = require("node:test");
const path = require("node:path");
require("reflect-metadata");
require("tsconfig-paths").register({ baseUrl: path.resolve(__dirname, "../dist"), paths: { "@/*": ["*"] } });
const { SiteSettingService } = require("../dist/site-setting/site-setting.service");
const { SiteSettingController } = require("../dist/site-setting/site-setting.controller");
const { RemoteProviderService } = require("../dist/remote-judge/remote-provider.service");
const { SubmissionMethod } = require("../dist/remote-judge/remote-judge.types");
const originalSession = process.env.NSOJ_ATCODER_SESSION;
const originalFetch = global.fetch;
beforeEach(() => {
  delete process.env.NSOJ_ATCODER_SESSION;
});
afterEach(() => {
  if (originalSession == null) delete process.env.NSOJ_ATCODER_SESSION;
  else process.env.NSOJ_ATCODER_SESSION = originalSession;
  global.fetch = originalFetch;
});
const admin = { id: 9, isAdmin: true };
function fixture() {
  const stored = new Map();
  const config = {
    config: { security: { sessionSecret: "test-site-secret" }, preference: { security: { allowRegister: true } } }
  };
  const repository = {
    findOneBy: async ({ key }) => (stored.has(key) ? structuredClone(stored.get(key)) : null),
    save: async entity => {
      stored.set(entity.key, structuredClone(entity));
    }
  };
  const service = new SiteSettingService(repository, config);
  return {
    stored,
    config,
    service,
    controller: new SiteSettingController(service),
    otherProcess: new SiteSettingService(repository, config)
  };
}

test("remote judge settings require site administration for both reads and mutations", async () => {
  const { controller, stored } = fixture();
  for (const user of [undefined, { id: 1 }, { id: 2, isAdmin: false, privileges: ["ManageProblem"] }]) {
    assert.deepEqual(await controller.getRemoteJudgeSettings(user), { error: "PERMISSION_DENIED" });
    assert.deepEqual(await controller.updateRemoteJudgeSettings(user, { atcoderSession: "test-session" }), {
      error: "PERMISSION_DENIED"
    });
    assert.deepEqual(await controller.updateRemoteJudgeSettings(user, { clearAtcoderSession: true }), {
      error: "PERMISSION_DENIED"
    });
  }
  assert.equal(stored.size, 0);
});

test("sessions are encrypted with fresh nonces, isolated from preferences and never returned in responses", async () => {
  const { controller, service, stored } = fixture();
  const secret = "test-session-never-return-this";
  const result = await controller.updateRemoteJudgeSettings(admin, { atcoderSession: secret });
  assert.equal(result.settings.atcoderSessionConfigured, true);
  assert.equal(result.settings.atcoderSessionSource, "site");
  assert.equal(await service.getAtcoderSession(), secret);
  const first = JSON.stringify([...stored.values()]);
  assert.doesNotMatch(first, /test-session-never-return-this/);
  assert.equal(stored.get("remote-judge:atcoder-session").updatedByUserId, admin.id);
  for (const value of [
    result,
    await controller.getRemoteJudgeSettings(admin),
    await service.getPreference(),
    await service.getPreferenceConfigToBeSentToUser()
  ]) {
    assert.doesNotMatch(JSON.stringify(value), /test-session-never-return-this|ciphertext|"iv"|"tag"/);
  }
  await controller.updateRemoteJudgeSettings(admin, { atcoderSession: secret });
  assert.notEqual(JSON.stringify([...stored.values()]), first);
  assert.equal(await service.getAtcoderSession(), secret);
});

test("live site configuration takes precedence across processes and clearing disables environment fallback", async () => {
  const { controller, service, otherProcess } = fixture();
  process.env.NSOJ_ATCODER_SESSION = "test-environment-session";
  assert.equal((await service.getRemoteJudgeSettings()).atcoderSessionSource, "environment");
  const redis = { pttl: async () => 0, set: async () => "OK" };
  const provider = new RemoteProviderService(
    { getSharedClient: () => redis },
    { lock: async (_, fn) => fn() },
    otherProcess
  );
  const cookies = [];
  global.fetch = async (_, options) => {
    cookies.push(options.headers.Cookie);
    return new Response("", { status: 200 });
  };
  assert.equal(await provider.hasAtcoderDirectSession(), true);
  await controller.updateRemoteJudgeSettings(admin, { atcoderSession: "REVEL_SESSION=test-site-one" });
  await provider.request(SubmissionMethod.AtCoder, "https://atcoder.jp/contests/abc480/submissions", true);
  await controller.updateRemoteJudgeSettings(admin, { atcoderSession: "test-site-two" });
  await provider.request(SubmissionMethod.AtCoder, "https://atcoder.jp/contests/abc480/submissions", true);
  assert.deepEqual(cookies, ["REVEL_SESSION=test-site-one", "REVEL_SESSION=test-site-two"]);
  await controller.updateRemoteJudgeSettings(admin, {});
  assert.equal(await otherProcess.getAtcoderSession(), "test-site-two");
  const cleared = await controller.updateRemoteJudgeSettings(admin, { clearAtcoderSession: true });
  assert.equal(cleared.settings.atcoderSessionConfigured, false);
  assert.equal(await provider.hasAtcoderDirectSession(), false);
  assert.equal(await service.getAtcoderSession(), undefined);
  await assert.rejects(provider.request(SubmissionMethod.AtCoder, "https://atcoder.jp/", true), /REMOTE_AUTH_REQUIRED/);
  assert.equal(cookies.length, 2);
});

test("invalid sessions are rejected without modifying stored credentials or echoing their content", async () => {
  const { controller, service } = fixture();
  await controller.updateRemoteJudgeSettings(admin, { atcoderSession: "test-existing-session" });
  for (const invalid of ["", " ", null, 123, "bad\r\nCookie: extra", "bad; extra=value", "a".repeat(8193)]) {
    await assert.rejects(
      controller.updateRemoteJudgeSettings(admin, { atcoderSession: invalid }),
      error => error.message === "INVALID_ATCODER_SESSION"
    );
    assert.equal(await service.getAtcoderSession(), "test-existing-session");
  }
  await assert.rejects(
    controller.updateRemoteJudgeSettings(admin, { atcoderSession: "test-session", clearAtcoderSession: true }),
    /INVALID_ATCODER_SESSION/
  );
  await assert.rejects(
    controller.updateRemoteJudgeSettings(admin, { clearAtcoderSession: "yes" }),
    /INVALID_ATCODER_SESSION/
  );
});

test("modified ciphertext and encryption key changes fail closed with a fixed error message", async () => {
  const { service, controller, stored, config } = fixture();
  await controller.updateRemoteJudgeSettings(admin, { atcoderSession: "test-sensitive-session" });
  const row = stored.get("remote-judge:atcoder-session");
  const ciphertext = row.value.ciphertext;
  row.value.ciphertext = (ciphertext[0] === "A" ? "B" : "A") + ciphertext.slice(1);
  await assert.rejects(service.getAtcoderSession(), error => error.message === "REMOTE_SESSION_UNREADABLE");
  assert.equal((await service.getRemoteJudgeSettings()).atcoderSessionError, "REMOTE_SESSION_UNREADABLE");
  row.value.ciphertext = ciphertext;
  config.config.security.sessionSecret = "different-key";
  await assert.rejects(service.getAtcoderSession(), error => error.message === "REMOTE_SESSION_UNREADABLE");
  await controller.updateRemoteJudgeSettings(admin, { atcoderSession: "test-replacement-session" });
  assert.equal(await service.getAtcoderSession(), "test-replacement-session");
});

test("session health distinguishes expired login from temporary access failures and recovers after success", async () => {
  const { controller, service } = fixture();
  const secret = "test-health-session";
  await controller.updateRemoteJudgeSettings(admin, { atcoderSession: secret });
  assert.equal((await service.getRemoteJudgeSettings()).atcoderSessionStatus, "unchecked");
  await service.recordAtcoderSessionCheck(secret, "REMOTE_AUTH_REQUIRED");
  let result = await controller.getRemoteJudgeSettings(admin);
  assert.equal(result.settings.atcoderSessionStatus, "expired");
  assert.equal(result.settings.atcoderSessionError, "REMOTE_AUTH_REQUIRED");
  assert.ok(result.settings.atcoderSessionLastCheckedAt instanceof Date);
  assert.doesNotMatch(JSON.stringify(result), /test-health-session|fingerprint|ciphertext/);
  for (const error of ["REMOTE_RATE_LIMITED", "REMOTE_PARSE_FAILED", "REMOTE_UNAVAILABLE"]) {
    await service.recordAtcoderSessionCheck(secret, error);
    assert.equal((await service.getRemoteJudgeSettings()).atcoderSessionStatus, "unavailable");
  }
  await service.recordAtcoderSessionCheck(secret);
  result = await controller.getRemoteJudgeSettings(admin);
  assert.equal(result.settings.atcoderSessionStatus, "valid");
  assert.equal(result.settings.atcoderSessionError, undefined);
});

test("replacement sessions ignore stale health and late failures from old requests", async () => {
  const { controller, service, stored } = fixture();
  await controller.updateRemoteJudgeSettings(admin, { atcoderSession: "old-session" });
  await service.recordAtcoderSessionCheck("old-session", "REMOTE_AUTH_REQUIRED");
  const stale = structuredClone(stored.get("remote-judge:atcoder-session-health"));
  const saved = await controller.updateRemoteJudgeSettings(admin, { atcoderSession: "new-session" });
  assert.equal(saved.settings.atcoderSessionStatus, "unchecked");
  await service.recordAtcoderSessionCheck("old-session", "REMOTE_AUTH_REQUIRED");
  assert.equal((await service.getRemoteJudgeSettings()).atcoderSessionStatus, "unchecked");
  await service.recordAtcoderSessionCheck("new-session");
  assert.equal((await service.getRemoteJudgeSettings()).atcoderSessionStatus, "valid");
  stored.set(stale.key, stale);
  assert.equal((await service.getRemoteJudgeSettings()).atcoderSessionStatus, "unchecked");
  await controller.updateRemoteJudgeSettings(admin, { clearAtcoderSession: true });
  assert.equal((await service.getRemoteJudgeSettings()).atcoderSessionStatus, "missing");
});

test("actual sync attempts publish health, while an empty target list does not falsely validate a session", async () => {
  const { service, controller } = fixture();
  await controller.updateRemoteJudgeSettings(admin, { atcoderSession: "sync-check-session" });
  const provider = new RemoteProviderService({}, {}, service);
  const account = { platform: SubmissionMethod.AtCoder, cursor: "0" };
  await provider.getPage(account, []);
  assert.equal((await service.getRemoteJudgeSettings()).atcoderSessionStatus, "unchecked");
  provider.atcoderLivePage = async () => {
    throw new Error("REMOTE_AUTH_REQUIRED");
  };
  await assert.rejects(provider.getPage(account, [{ contestId: "abc480", since: 0 }]), /REMOTE_AUTH_REQUIRED/);
  assert.equal((await service.getRemoteJudgeSettings()).atcoderSessionStatus, "expired");
  provider.atcoderLivePage = async () => ({ submissions: [], pending: false });
  await provider.getPage(account, [{ contestId: "abc480", since: 0 }]);
  assert.equal((await service.getRemoteJudgeSettings()).atcoderSessionStatus, "valid");
});
