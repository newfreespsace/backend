const assert = require("node:assert/strict");
const { test, beforeEach, afterEach } = require("node:test");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
require("reflect-metadata");
require("tsconfig-paths").register({ baseUrl: path.resolve(__dirname, "../dist"), paths: { "@/*": ["*"] } });
const { RemoteProviderService } = require("../dist/remote-judge/remote-provider.service");
const { safeRemoteErrorDetails } = require("../dist/remote-judge/remote-error");
const { safeCodeforcesRequest } = require("../dist/remote-judge/codeforces-request-profile");
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
  provider.redisService = {
    getSharedClient: () => ({ pttl: async () => 0, set: async () => "OK", del: async () => 1 })
  };
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

test("CF sourceBase64 preserves UTF-8, BOM and line endings without restarting history after a missing-source error", async () => {
  const source = "\ufeff// 中文与 emoji 🙂\r\nint main() { return 0; }\r\n";
  const encodedRow = row();
  delete encodedRow.source;
  encodedRow.sourceBase64 = Buffer.from(source, "utf8").toString("base64");
  let calls = 0;
  global.fetch = async address => {
    calls++;
    const params = new URL(address).searchParams;
    assert.equal(params.get("includeSources"), "true");
    assert.equal(params.get("from"), "301");
    return new Response(
      JSON.stringify({ status: "OK", result: Array.from({ length: 20 }, (_, i) => ({ ...encodedRow, id: 1000 - i })) })
    );
  };
  const page = await providerFixture().getPage({
    ...account(),
    cursor: "900",
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
  assert.equal(page.cursor, "900");
  assert.equal(page.scan.offset, 321);
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
  assert.equal(page.sourceErrorDetails.stage, "body");
  assert.match(page.sourceErrorDetails.request.url, /count=20&includeSources=true$/);
  assert.doesNotMatch(JSON.stringify(page.sourceErrorDetails), /testKey123|testSecret456|secret must not escape/);
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

test("a credential storage failure does not cause a public fallback request", async () => {
  const provider = providerFixture();
  provider.codeforcesCredentials.get = async () => {
    throw new Error("credential storage unavailable");
  };
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ status: "OK", result: [] }));
  };
  await assert.rejects(provider.getPage(account()), /credential storage unavailable/);
  assert.equal(calls, 0);
});

test("a successful response without source is reported separately, never silently claiming source sync works", async () => {
  const publicRow = row();
  delete publicRow.source;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ status: "OK", result: [publicRow] }));
  };
  const page = await providerFixture().getPage(account());
  assert.equal(calls, 1, "the source response already contains the public results");
  assert.equal(page.sourceError, "REMOTE_CF_SOURCE_MISSING");
  assert.equal(page.submissions[0].sourceCode, undefined);
  assert.equal(page.submissions[0].status, "Accepted");
});

test("partially missing sources retain valid code and results without an extra public request", async () => {
  const missing = row(999);
  delete missing.source;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ status: "OK", result: [row(), missing] }));
  };
  const page = await providerFixture().getPage(account());
  assert.equal(calls, 1);
  assert.equal(page.sourceError, "REMOTE_CF_SOURCE_MISSING");
  assert.equal(page.submissions[0].sourceCode, row().source);
  assert.equal(page.submissions[1].sourceCode, undefined);
  assert.ok(page.submissions.every(submission => submission.status === "Accepted"));
});

test("recovered source authorization retains the current history checkpoint", async () => {
  let offset;
  global.fetch = async address => {
    offset = new URL(address).searchParams.get("from");
    return new Response(JSON.stringify({ status: "OK", result: Array.from({ length: 20 }, (_, i) => row(1000 - i)) }));
  };
  const page = await providerFixture().getPage({
    ...account(),
    cursor: "900",
    scan: { offset: 301, head: 1000 },
    codeforcesSourceError: "REMOTE_CF_AUTH_FAILED",
    codeforcesSourceRetryAt: new Date(0)
  });
  assert.equal(offset, "301");
  assert.equal(page.more, true);
  assert.equal(page.cursor, "900");
  assert.equal(page.scan.offset, 321);
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

test("network and HTTP failures retain the source checkpoint without an immediate retry or public fallback", async () => {
  for (const failure of [
    "timeout",
    "reset",
    "body timeout",
    "HTTP 502",
    "HTTP 503",
    "HTTP 302",
    "HTTP 401",
    "HTTP 404"
  ]) {
    diagnostics.length = 0;
    const provider = providerFixture();
    let calls = 0;
    global.fetch = async address => {
      calls++;
      assert.equal(new URL(address).searchParams.get("from"), "41");
      if (failure === "timeout") throw new DOMException("private timeout text", "TimeoutError");
      if (failure === "reset")
        throw Object.assign(new TypeError("private fetch text"), { cause: { code: "ECONNRESET" } });
      if (failure === "body timeout")
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          text: async () => {
            throw new DOMException("private body text", "TimeoutError");
          }
        };
      return new Response("private response", { status: Number(failure.slice(-3)) });
    };
    const current = { ...account(), scan: { offset: 41, head: 1000 }, cursor: "900" };
    await assert.rejects(provider.getPage(current), error => {
      assert.equal(error.message, "REMOTE_UNAVAILABLE");
      const request = error.details.request;
      assert.equal(
        request.url,
        "https://codeforces.com/api/user.status?handle=coder&from=41&count=20&includeSources=true"
      );
      assert.match(request.command, /CODEFORCES_API_SECRET/);
      assert.deepEqual(safeRemoteErrorDetails(error.details), error.details);
      assert.doesNotMatch(JSON.stringify(error.details), /testKey123|testSecret456|private/);
      return true;
    });
    assert.equal(calls, 1, failure);
    assert.equal(current.scan.offset, 41);
    assert.equal(current.cursor, "900");
    assert.equal(current.codeforcesSourceError, undefined);
    assert.doesNotMatch(diagnostics.join(" "), /private|testKey123|testSecret456|apiSig/);
  }
});

test("CF reproduction commands regenerate valid signatures locally and discard stored secrets and commands", () => {
  const url = "https://codeforces.com/api/user.status?handle=coder&from=41&count=20&includeSources=true";
  const details = safeRemoteErrorDetails({
    request: {
      url: `${url}&apiKey=private-key&time=1&apiSig=private-signature`,
      command: "private command",
      headers: { Authorization: "private-header" }
    }
  });
  assert.equal(details.request.url, url);
  assert.doesNotMatch(JSON.stringify(details), /private/);
  assert.deepEqual(safeRemoteErrorDetails(details), details);
  const replay = spawnSync("sh", ["-c", `curl() { printf '%s\\n' "$@"; }; ${details.request.command}`], {
    encoding: "utf8",
    env: { ...process.env, CODEFORCES_API_KEY: credentials.apiKey, CODEFORCES_API_SECRET: credentials.apiSecret }
  });
  assert.equal(replay.status, 0, replay.stderr);
  const args = replay.stdout.trim().split("\n");
  assert.deepEqual(args.slice(0, -1), [
    "--request",
    "GET",
    "--max-time",
    "20",
    "--user-agent",
    "NSOJ-Result-Sync/1.0",
    "--header",
    "Accept: application/json,text/html"
  ]);
  const signed = new URL(args.at(-1));
  const signature = signed.searchParams.get("apiSig");
  signed.searchParams.delete("apiSig");
  signed.searchParams.sort();
  assert.equal(
    signature.slice(6),
    createHash("sha512")
      .update(`${signature.slice(0, 6)}/user.status?${signed.searchParams}#${credentials.apiSecret}`)
      .digest("hex")
  );
  assert.equal(signed.searchParams.get("apiKey"), credentials.apiKey);
  assert.ok(Math.abs(Number(signed.searchParams.get("time")) - Date.now() / 1000) < 5);
  assert.equal(signed.searchParams.get("from"), "41");
  assert.equal(signed.searchParams.get("includeSources"), "true");
  const unsigned = safeCodeforcesRequest(url.replace("&includeSources=true", ""));
  assert.doesNotMatch(unsigned.command, /CODEFORCES_API|node -e/);
  assert.match(unsigned.command, /count=20/);
});

test("CF request diagnostics reject arbitrary endpoints, duplicate parameters and shell injection", () => {
  const url = "https://codeforces.com/api/user.status?handle=coder&from=1&count=20&includeSources=true";
  for (const unsafe of [
    url.replace("codeforces.com", "example.com"),
    url.replace("https://", "https://user:private@"),
    url.replace("user.status", "user.friends"),
    url.replace("coder&", "coder%27%24%28echo%20private%29&"),
    url.replace("from=1", "from=0"),
    `${url}&handle=other`,
    `${url}&apiSecret=private`,
    `${url}#private`
  ])
    assert.deepEqual(safeRemoteErrorDetails({ request: { url: unsafe, command: "private" } }), {});
});

test("lock, Redis and TLS failures have safe diagnostics and do not add requests", async () => {
  for (const failure of ["lock", "redis", "tls"]) {
    diagnostics.length = 0;
    const provider = providerFixture();
    let lockEntries = 0;
    provider.lockService.lock = async (_, fn) => {
      lockEntries++;
      if (failure === "lock") throw new Error("private lock text");
      return fn();
    };
    provider.redisService.getSharedClient = () => ({
      pttl: async () => {
        if (failure === "redis") throw new Error("private redis text");
        return 0;
      },
      set: async () => "OK"
    });
    global.fetch = async () => {
      throw Object.assign(new TypeError("private certificate text"), { cause: { code: "CERT_HAS_EXPIRED" } });
    };
    await assert.rejects(provider.getPage(account()), /REMOTE_UNAVAILABLE/);
    assert.equal(lockEntries, 1, failure);
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
