const assert = require("node:assert/strict");
const { test, beforeEach, afterEach } = require("node:test");
const { createHash } = require("node:crypto");
const path = require("node:path");
require("reflect-metadata");
require("tsconfig-paths").register({ baseUrl: path.resolve(__dirname, "../dist"), paths: { "@/*": ["*"] } });
const { RemoteProviderService } = require("../dist/remote-judge/remote-provider.service");
const { CodeforcesCredentialsService } = require("../dist/remote-judge/codeforces-credentials.service");
const { RemoteJudgeService } = require("../dist/remote-judge/remote-judge.service");
const { SubmissionMethod: Method } = require("../dist/remote-judge/remote-judge.types");
const { RequestLogMiddleware } = require("../dist/request-log.middleware");
const { EventReportService } = require("../dist/event-report/event-report.service");
const { logger } = require("../dist/logger");
const originalFetch = global.fetch;
const originalWarn = logger.warn;
const originalLog = logger.log;
let diagnostics;
beforeEach(() => {
  diagnostics = [];
  logger.warn = message => diagnostics.push(message);
  logger.log = message => diagnostics.push(message);
});
afterEach(() => {
  global.fetch = originalFetch;
  logger.warn = originalWarn;
  logger.log = originalLog;
});
const credentials = { apiKey: "testKey123", apiSecret: "testSecret456" };
const account = () => ({
  id: 3,
  userId: 1,
  platform: Method.Codeforces,
  handle: "coder",
  handleKey: "coder",
  cursor: "0",
  codeforcesSourceEnabled: true
});
const row = (id = 1000) => ({
  id,
  problem: { contestId: 4, index: "A" },
  author: { members: [{ handle: "coder" }] },
  creationTimeSeconds: 1700000000,
  verdict: "OK",
  programmingLanguage: "GNU C++20",
  timeConsumedMillis: 31,
  memoryConsumedBytes: 4096,
  passedTestCount: 7,
  testset: "TESTS",
  source: "int main() {}\n"
});
function providerFixture() {
  const provider = Object.create(RemoteProviderService.prototype);
  provider.codeforcesCredentials = { get: async () => credentials };
  provider.lockService = { lock: async (_, fn) => fn() };
  provider.redisService = { getSharedClient: () => ({ pttl: async () => 0, set: async () => "OK" }) };
  return provider;
}

test("signed source sync uses the official SHA-512 protocol and preserves test summaries", async () => {
  let calls = 0;
  global.fetch = async (address, options) => {
    calls++;
    const url = new URL(address);
    assert.equal(url.origin, "https://codeforces.com");
    assert.equal(url.searchParams.get("includeSources"), "true");
    assert.equal(url.searchParams.get("count"), "20");
    assert.equal(url.searchParams.get("apiKey"), credentials.apiKey);
    assert.ok(Math.abs(Number(url.searchParams.get("time")) - Date.now() / 1000) < 5);
    const signature = url.searchParams.get("apiSig");
    url.searchParams.delete("apiSig");
    url.searchParams.sort();
    const expected = createHash("sha512")
      .update(`${signature.slice(0, 6)}/user.status?${url.searchParams}#${credentials.apiSecret}`)
      .digest("hex");
    assert.equal(signature.slice(6), expected);
    assert.equal(address.includes(credentials.apiSecret), false);
    assert.equal(options.redirect, "manual");
    assert.equal(options.headers.Cookie, undefined);
    return new Response(
      JSON.stringify({ status: "OK", result: [row(), { ...row(999), author: { members: [{ handle: "another" }] } }] })
    );
  };
  const page = await providerFixture().getPage(account());
  assert.equal(calls, 1);
  assert.equal(page.submissions.length, 1);
  assert.equal(page.submissions[0].sourceCode, "int main() {}\n");
  assert.equal(page.submissions[0].passedTestCount, 7);
  assert.equal(page.submissions[0].testset, "TESTS");
  assert.equal(page.sourceError, undefined);
});

test("CF sourceBase64 preserves UTF-8, BOM and line endings and resumes history after a missing-source error", async () => {
  const source = "\ufeff// 中文与 emoji 🙂\r\nint main() { return 0; }\r\n";
  const encodedRow = row();
  delete encodedRow.source;
  encodedRow.sourceBase64 = Buffer.from(source, "utf8").toString("base64");
  let calls = 0;
  global.fetch = async address => {
    calls++;
    const params = new URL(address).searchParams;
    assert.equal(params.get("includeSources"), "true");
    assert.equal(params.get("from"), "1");
    return new Response(
      JSON.stringify({ status: "OK", result: Array.from({ length: 20 }, (_, i) => ({ ...encodedRow, id: 1000 - i })) })
    );
  };
  const page = await providerFixture().getPage({
    ...account(),
    cursor: "999",
    scan: { offset: 301, head: 1000 },
    codeforcesSourceError: "REMOTE_CF_SOURCE_MISSING",
    codeforcesSourceRetryAt: new Date(0)
  });
  assert.equal(calls, 1, "a valid Base64 source must not fall back to the public API");
  assert.equal(page.sourceError, undefined);
  assert.equal(page.submissions[0].sourceCode, source);
  assert.equal(page.submissions[0].passedTestCount, 7);
  assert.equal(page.submissions[0].testset, "TESTS");
  assert.equal(page.more, true);
  assert.equal(page.cursor, "0");
  assert.equal(page.scan.offset, 21);
});

test("malformed, invalid UTF-8 and oversized Base64 sources cannot become silently corrupted code", async () => {
  for (const [encoded, error] of [
    ["%%invalid", "REMOTE_CF_SOURCE_INVALID"],
    ["a", "REMOTE_CF_SOURCE_INVALID"],
    ["Zh==", "REMOTE_CF_SOURCE_INVALID"],
    ["/w==", "REMOTE_CF_SOURCE_INVALID"],
    [Buffer.alloc(1024 * 1024 + 1).toString("base64"), "REMOTE_CF_SOURCE_TOO_LARGE"]
  ]) {
    global.fetch = async address => {
      const submission = row();
      delete submission.source;
      if (new URL(address).searchParams.has("apiKey")) submission.sourceBase64 = encoded;
      return new Response(JSON.stringify({ status: "OK", result: [submission] }));
    };
    const page = await providerFixture().getPage(account());
    assert.equal(page.sourceError, error);
    assert.equal(page.submissions[0].sourceCode, undefined);
    assert.equal(page.submissions[0].status, "Accepted");
    assert.equal(page.submissions[0].passedTestCount, 7);
  }
});

test("source sync stays opt-in while public summaries work without credentials", async () => {
  const provider = providerFixture();
  provider.codeforcesCredentials.get = async () => {
    throw new Error("must not load credentials");
  };
  global.fetch = async address => {
    assert.equal(new URL(address).searchParams.has("apiKey"), false);
    assert.equal(new URL(address).searchParams.has("includeSources"), false);
    return new Response(JSON.stringify({ status: "OK", result: [row()] }));
  };
  const page = await provider.getPage({ ...account(), codeforcesSourceEnabled: false });
  assert.equal(page.submissions[0].passedTestCount, 7);
  assert.equal(page.submissions[0].sourceCode, undefined);
});

test("invalid credentials fall back to public results, with a separate source retry cooldown", async () => {
  const requests = [];
  global.fetch = async address => {
    const url = new URL(address);
    requests.push(url);
    if (url.searchParams.has("apiKey"))
      return new Response(JSON.stringify({ status: "FAILED", comment: "Invalid API key: secret must not escape" }));
    const publicRow = row();
    delete publicRow.source;
    return new Response(JSON.stringify({ status: "OK", result: [publicRow] }));
  };
  const provider = providerFixture();
  const page = await provider.getPage(account());
  assert.equal(requests.length, 2);
  assert.equal(page.sourceError, "REMOTE_CF_AUTH_FAILED");
  assert.equal(page.submissions[0].status, "Accepted");
  assert.equal(page.submissions[0].passedTestCount, 7);
  assert.equal(page.submissions[0].sourceCode, undefined);
  assert.ok(page.sourceRetryAt > new Date());
  await provider.getPage({
    ...account(),
    codeforcesSourceError: page.sourceError,
    codeforcesSourceRetryAt: page.sourceRetryAt
  });
  assert.equal(requests.length, 3);
  assert.equal(requests[2].searchParams.has("apiKey"), false);
});

test("a successful response without source is reported separately, never silently claiming source sync works", async () => {
  const publicRow = row();
  delete publicRow.source;
  global.fetch = async () => new Response(JSON.stringify({ status: "OK", result: [publicRow] }));
  const page = await providerFixture().getPage(account());
  assert.equal(page.sourceError, "REMOTE_CF_SOURCE_MISSING");
  assert.equal(page.submissions[0].sourceCode, undefined);
  assert.equal(page.submissions[0].status, "Accepted");
});

test("recovered source authorization restarts history skipped by public-only sync", async () => {
  let offset;
  global.fetch = async address => {
    offset = new URL(address).searchParams.get("from");
    return new Response(JSON.stringify({ status: "OK", result: Array.from({ length: 20 }, (_, i) => row(1000 - i)) }));
  };
  const page = await providerFixture().getPage({
    ...account(),
    cursor: "999",
    scan: { offset: 301, head: 1000 },
    codeforcesSourceError: "REMOTE_CF_AUTH_FAILED",
    codeforcesSourceRetryAt: new Date(0)
  });
  assert.equal(offset, "1");
  assert.equal(page.more, true);
  assert.equal(page.cursor, "0");
  assert.equal(page.scan.offset, 21);
});

test("small source pages visit every submission and preserve pending checkpoints across page boundaries", async () => {
  const allRows = Array.from({ length: 45 }, (_, i) => row(1000 - i));
  allRows[22].verdict = "TESTING";
  const offsets = [];
  global.fetch = async address => {
    const params = new URL(address).searchParams;
    assert.equal(params.get("includeSources"), "true");
    assert.equal(params.get("count"), "20");
    const offset = Number(params.get("from"));
    offsets.push(offset);
    return new Response(JSON.stringify({ status: "OK", result: allRows.slice(offset - 1, offset + 19) }));
  };
  const provider = providerFixture();
  let current = account();
  const imported = [];
  let page;
  for (let i = 0; i < 3; i++) {
    page = await provider.getPage(current);
    imported.push(...page.submissions);
    current = { ...current, cursor: page.cursor, scan: page.scan };
    assert.equal(page.more, i < 2);
  }
  assert.deepEqual(offsets, [1, 21, 41]);
  assert.deepEqual(
    imported.map(item => Number(item.id)),
    allRows.map(item => item.id)
  );
  assert.ok(imported.every(item => item.sourceCode === "int main() {}\n"));
  assert.equal(page.pending, true);
  assert.equal(page.cursor, "977");
  assert.equal(page.scan, null);
});

test("transient source failures retry once through the shared limiter and recover without a cooldown", async () => {
  for (const failure of ["timeout", "reset", "body timeout", "HTTP 502", "HTTP 503"]) {
    diagnostics.length = 0;
    const provider = providerFixture();
    let limiterEntries = 0;
    let rateWrites = 0;
    provider.lockService.lock = async (_, fn) => {
      limiterEntries++;
      return fn();
    };
    provider.redisService.getSharedClient = () => ({
      pttl: async () => 0,
      set: async () => {
        rateWrites++;
        return "OK";
      }
    });
    const requests = [];
    global.fetch = async (address, options) => {
      const params = new URL(address).searchParams;
      assert.equal(params.get("includeSources"), "true", "a recovered source request needs no public fallback");
      requests.push({ params, signal: options.signal });
      if (requests.length === 1) {
        if (failure === "timeout") throw new DOMException("private timeout text", "TimeoutError");
        if (failure === "reset")
          throw Object.assign(new TypeError("private fetch text"), { cause: { code: "ECONNRESET" } });
        if (failure === "body timeout")
          return {
            ok: true,
            status: 200,
            text: async () => {
              throw new DOMException("private body text", "TimeoutError");
            }
          };
        return new Response("private error page", { status: Number(failure.slice(-3)) });
      }
      return new Response(JSON.stringify({ status: "OK", result: [row()] }));
    };
    const page = await provider.getPage(account());
    assert.equal(requests.length, 2, failure);
    assert.equal(limiterEntries, 2);
    assert.equal(rateWrites, 2);
    assert.notEqual(requests[0].params.get("apiSig"), requests[1].params.get("apiSig"));
    assert.notEqual(requests[0].signal, requests[1].signal);
    assert.equal(page.sourceError, undefined);
    assert.equal(page.sourceRetryAt, undefined);
    assert.equal(page.submissions[0].sourceCode, row().source);
    const diagnostic = JSON.parse(diagnostics[0].split("Remote request failed: ")[1]);
    assert.equal(diagnostic.sourceRequest, true);
    assert.equal(diagnostic.accountId, 3);
    assert.equal(
      diagnostic.reason,
      failure.includes("timeout") ? "TIMEOUT" : failure === "reset" ? "NETWORK_ERROR" : "HTTP_ERROR"
    );
    assert.equal(diagnostic.stage, failure === "body timeout" ? "body" : "request");
    assert.equal(typeof diagnostic.lockWaitMs, "number");
    assert.equal(typeof diagnostic.durationMs, "number");
    assert.match(diagnostics.join(" "), /transient request recovered/);
    assert.doesNotMatch(diagnostics.join(" "), /private|testKey123|testSecret456|apiSig/);
  }
});

test("persistent network failures fall back to full public pages and retain the five-minute cooldown", async () => {
  const requests = [];
  const provider = providerFixture();
  global.fetch = async address => {
    const params = new URL(address).searchParams;
    requests.push(params);
    if (params.has("apiKey"))
      throw Object.assign(new TypeError(`fetch ${address} ${credentials.apiSecret} private-source`), {
        cause: { code: "ECONNRESET", message: "private-cookie" }
      });
    assert.equal(params.get("count"), "100");
    return new Response(JSON.stringify({ status: "OK", result: Array.from({ length: 100 }, (_, i) => row(1000 - i)) }));
  };
  const before = Date.now();
  const page = await provider.getPage(account());
  assert.equal(requests.length, 3);
  assert.equal(page.sourceError, "REMOTE_UNAVAILABLE");
  assert.ok(+page.sourceRetryAt >= before + 300000);
  assert.ok(+page.sourceRetryAt <= Date.now() + 300000);
  assert.equal(page.more, true);
  assert.equal(page.scan.offset, 101, "public fallback must use its own page size");
  assert.equal(page.submissions.length, 100);
  assert.ok(page.submissions.every(item => item.sourceCode === undefined));
  await provider.getPage({
    ...account(),
    codeforcesSourceError: page.sourceError,
    codeforcesSourceRetryAt: page.sourceRetryAt
  });
  assert.equal(requests.length, 4);
  assert.equal(requests[3].has("apiKey"), false);
  const logs = diagnostics.join(" ");
  assert.match(logs, /ECONNRESET/);
  assert.doesNotMatch(logs, /testKey123|testSecret456|apiSig|https:|private-/);
});

test("access denial, rate limits, redirects and non-transient HTTP errors are not immediately retried", async () => {
  for (const [status, code, reason] of [
    [403, "REMOTE_ACCESS_DENIED", "REMOTE_ACCESS_DENIED"],
    [429, "REMOTE_RATE_LIMITED", "REMOTE_RATE_LIMITED"],
    [302, "REMOTE_UNAVAILABLE", "REDIRECT"],
    [401, "REMOTE_UNAVAILABLE", "HTTP_ERROR"],
    [404, "REMOTE_UNAVAILABLE", "HTTP_ERROR"]
  ]) {
    diagnostics.length = 0;
    let calls = 0;
    global.fetch = async address => {
      calls++;
      return new URL(address).searchParams.has("apiKey")
        ? new Response("private response", { status })
        : new Response(JSON.stringify({ status: "OK", result: [row()] }));
    };
    const page = await providerFixture().getPage(account());
    assert.equal(calls, 2, `HTTP ${status} should fall back directly`);
    assert.equal(page.sourceError, code);
    const diagnostic = JSON.parse(diagnostics[0].split("Remote request failed: ")[1]);
    assert.equal(diagnostic.httpStatus, status);
    assert.equal(diagnostic.reason, reason);
  }
});

test("lock, Redis and TLS failures have safe diagnostics and do not add source retries", async () => {
  for (const failure of ["lock", "redis", "tls"]) {
    diagnostics.length = 0;
    const provider = providerFixture();
    let lockEntries = 0;
    provider.lockService.lock = async (_, fn) => {
      lockEntries++;
      if (failure === "lock" && lockEntries === 1) throw new Error("private lock text");
      return fn();
    };
    let redisCalls = 0;
    provider.redisService.getSharedClient = () => ({
      pttl: async () => {
        redisCalls++;
        if (failure === "redis" && redisCalls === 1) throw new Error("private redis text");
        return 0;
      },
      set: async () => "OK"
    });
    global.fetch = async address => {
      if (new URL(address).searchParams.has("apiKey"))
        throw Object.assign(new TypeError("private certificate text"), { cause: { code: "CERT_HAS_EXPIRED" } });
      return new Response(JSON.stringify({ status: "OK", result: [row()] }));
    };
    const page = await provider.getPage(account());
    assert.equal(page.sourceError, "REMOTE_UNAVAILABLE");
    assert.equal(lockEntries, 2, failure);
    const diagnostic = JSON.parse(diagnostics[0].split("Remote request failed: ")[1]);
    assert.equal(
      diagnostic.reason,
      failure === "lock" ? "LOCK_FAILED" : failure === "redis" ? "RATE_LIMIT_STORE_FAILED" : "NETWORK_ERROR"
    );
    if (failure === "tls") assert.equal(diagnostic.networkCode, "CERT_HAS_EXPIRED");
    assert.doesNotMatch(diagnostics.join(" "), /private|testKey123|testSecret456|apiSig/);
  }
});

test("credentials are encrypted, bound to their owner, excluded from normal selection and removable", async () => {
  const saved = account();
  const service = Object.create(CodeforcesCredentialsService.prototype);
  service.configService = { config: { security: { sessionSecret: "server-secret" } } };
  service.accounts = {
    findOne: async query => {
      assert.ok(query.select.includes("codeforcesCredentials"));
      return saved;
    }
  };
  saved.codeforcesCredentials = service.encrypt(saved, credentials);
  assert.doesNotMatch(JSON.stringify(saved.codeforcesCredentials), /testKey123|testSecret456/);
  assert.deepEqual(await service.get(saved.id), credentials);
  saved.userId = 2;
  await assert.rejects(service.get(saved.id), /REMOTE_CF_CREDENTIALS_UNREADABLE/);
  saved.userId = 1;
  service.configService.config.security.sessionSecret = "changed-secret";
  await assert.rejects(service.get(saved.id), /REMOTE_CF_CREDENTIALS_UNREADABLE/);
  saved.codeforcesSourceEnabled = false;
  assert.equal(await service.get(saved.id), undefined);
});

test("credential updates require the bound owner, reset history and never return keys or ciphertext", async () => {
  const saved = account();
  saved.codeforcesSourceEnabled = false;
  const service = Object.create(RemoteJudgeService.prototype);
  service.configService = { config: {} };
  service.lockService = { lock: async (_, fn) => fn() };
  service.codeforcesCredentials = {
    encrypt: () => ({ iv: "private-iv", tag: "private-tag", ciphertext: "private-ciphertext" })
  };
  service.accounts = {
    findOneBy: async where => (where.userId === saved.userId ? saved : null),
    findBy: async () => [saved],
    update: async (_, patch) => Object.assign(saved, patch)
  };
  await assert.rejects(service.setCodeforcesCredentials({ id: 2 }, credentials), /CF_ACCOUNT_REQUIRED/);
  for (const request of [
    {},
    { apiKey: "one" },
    { clear: true, apiKey: "key" },
    { apiKey: "bad key", apiSecret: "secret" }
  ])
    await assert.rejects(service.setCodeforcesCredentials({ id: 1 }, request), /INVALID_CF_CREDENTIALS/);
  const result = await service.setCodeforcesCredentials({ id: 1 }, credentials);
  assert.equal(saved.cursor, "0");
  assert.equal(saved.scan, null);
  assert.equal(saved.catchUpRequested, true);
  assert.equal(result.accounts[0].codeforcesSourceEnabled, true);
  assert.doesNotMatch(JSON.stringify(result), /testKey123|testSecret456|private-/);
  const cleared = await service.setCodeforcesCredentials({ id: 1 }, { clear: true });
  assert.equal(saved.codeforcesCredentials, null);
  assert.equal(cleared.accounts[0].codeforcesSourceEnabled, false);
});

test("request logging and error reports redact CF credentials without mutating the actual request", async () => {
  const request = {
    method: "POST",
    originalUrl: "/api/remoteJudge/setCodeforcesCredentials",
    query: {},
    body: { ...credentials, nested: { atcoderSession: "private-session" } }
  };
  const originalLog = console.log;
  let logged;
  try {
    console.log = (...args) => {
      logged = JSON.stringify(args);
    };
    let continued = false;
    new RequestLogMiddleware().use(request, {}, () => {
      continued = true;
    });
    assert.equal(continued, true);
    assert.doesNotMatch(logged, /testKey123|testSecret456|private-session/);
    assert.match(logged, /REDACTED/);
  } finally {
    console.log = originalLog;
  }
  const reporter = Object.create(EventReportService.prototype);
  reporter.enabled = true;
  reporter.configService = { config: { preference: { siteName: "Test" } } };
  let report;
  reporter.clusterSerivce = {
    postMessageToMaster: (_, message) => {
      report = message;
    }
  };
  await reporter.report({ type: "Error", request });
  assert.doesNotMatch(JSON.stringify(report), /testKey123|testSecret456|private-session/);
  assert.equal(request.body.apiKey, credentials.apiKey);
  assert.equal(request.body.apiSecret, credentials.apiSecret);
});

test("session tokens in URLs, repeated encoded query fields and bodies never enter logs or error reports", async () => {
  const request = {
    method: "GET",
    originalUrl:
      "/api/auth/getSessionInfo?jsonp=1&token=test-login-secret&%74oken=test-encoded-secret&TOKEN=test-repeat-secret&bad%=keep",
    query: { jsonp: "1", token: ["test-login-secret", "test-encoded-secret"], TOKEN: "test-repeat-secret" },
    body: { nested: { token: "test-body-secret" } }
  };
  const before = structuredClone(request);
  const originalLog = console.log;
  let logged;
  try {
    console.log = (...args) => {
      logged = JSON.stringify(args);
    };
    new RequestLogMiddleware().use(request, {}, () => {});
  } finally {
    console.log = originalLog;
  }
  assert.doesNotMatch(logged, /test-(login|encoded|repeat|body)-secret/);
  assert.match(logged, /jsonp=1/);
  assert.match(logged, /bad%=keep/);
  assert.match(logged, /REDACTED/);
  const reporter = Object.create(EventReportService.prototype);
  reporter.enabled = true;
  reporter.configService = { config: { preference: { siteName: "Test" } } };
  let report;
  reporter.clusterSerivce = { postMessageToMaster: (_, message) => (report = message) };
  await reporter.report({ type: "Error", request });
  assert.doesNotMatch(JSON.stringify(report), /test-(login|encoded|repeat|body)-secret/);
  assert.match(report.message, /getSessionInfo\?jsonp=1/);
  assert.deepEqual(request, before);
});
