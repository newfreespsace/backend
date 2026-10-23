const assert = require("node:assert/strict");
const { test, afterEach } = require("node:test");
const path = require("node:path");
require("reflect-metadata");
require("tsconfig-paths").register({ baseUrl: path.resolve(__dirname, "../dist"), paths: { "@/*": ["*"] } });
const { RemoteProviderService } = require("../dist/remote-judge/remote-provider.service");
const { parseAtcoderSubmissionPage } = require("../dist/remote-judge/atcoder-submission.parser");
const { SubmissionMethod: Method } = require("../dist/remote-judge/remote-judge.types");
const { SubmissionStatus: Status } = require("../dist/submission/submission-status.enum");
const { safeRemoteErrorDetails } = require("../dist/remote-judge/remote-error");
const { ATCODER_USER_AGENT } = require("../dist/remote-judge/atcoder-request");

let personalSession;
const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

const account = { id: 1, platform: Method.AtCoder, handle: "coder", cursor: "1792510000" };
const targets = [{ contestId: "abc480", since: 1792510000 }];
function row({
  id = 80223806,
  contest = "abc480",
  user = "coder",
  verdict = "WA",
  time = "2026-10-21 00:50:33+0900",
  exec = "0 ms",
  memory = "1,616 KiB",
  score = "0"
} = {}) {
  return `<tr><td><time class="fixtime fixtime-second">${time}</time></td>
    <td><a href="/contests/${contest}/tasks/${contest}_a">A - ADjacent</a></td>
    <td><a href="/users/${user}">${user}</a></td><td><a>C++23 (GCC 15.2.0)</a></td>
    <td>${score}</td><td>13 Byte</td><td><span class="label">${verdict}</span></td>
    <td>${exec}</td><td>${memory}</td>
    <td><a class="submission-details-link" href="/contests/${contest}/submissions/${id}">Detail</a></td></tr>`;
}
function html(rows = [], { contest = "abc480", page = 1, more = false } = {}) {
  return `<table><thead><tr>${[
    "Submission Time",
    "Task",
    "User",
    "Language",
    "Score",
    "Code Size",
    "Status",
    "Exec Time",
    "Memory",
    ""
  ]
    .map(header => `<th>${header}</th>`)
    .join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>
    ${
      more
        ? `<ul class="pagination"><li><a href="/contests/${contest}/submissions?page=${
            page + 1
          }&amp;f.User=coder">Next</a></li></ul>`
        : ""
    }`;
}
function fixture(handler, statusHandler) {
  personalSession = "test-dedicated-session";
  const values = new Map();
  const expirations = new Map();
  const calls = [];
  const provider = Object.create(RemoteProviderService.prototype);
  provider.atcoderSessions = {
    get: async () => personalSession?.trim()
  };
  provider.redisService = {
    getSharedClient: () => ({
      get: async key => values.get(key) ?? null,
      incr: async () => 1,
      pexpire: async () => 1,
      set: async (key, value, unit, ttl, nx) => {
        if (nx === "NX" && (expirations.get(key) || 0) > Date.now()) return null;
        values.set(key, value);
        if (unit === "PX") expirations.set(key, Date.now() + ttl);
        return "OK";
      },
      pttl: async key =>
        key.startsWith("remote-atcoder-cooldown:") ? Math.max(0, (expirations.get(key) || 0) - Date.now()) : 0
    })
  };
  provider.lockService = { lock: async (_, fn) => fn() };
  if (handler)
    provider.request = async (platform, address, authenticated) => {
      const url = new URL(address);
      calls.push({ url, authenticated });
      assert.equal(url.origin, "https://atcoder.jp", "AtCoder sync must never contact third-party services");
      if (url.pathname.endsWith("/status/json")) return statusHandler ? statusHandler(url) : statusJson([]);
      return handler(url, authenticated);
    };
  return { provider, values, calls, expirations };
}

test("original HTML preserves JST timestamps, task IDs, verdicts, points and resource units", () => {
  const result = parseAtcoderSubmissionPage(
    html([row(), row({ id: 9, user: "someone" })], { more: true }),
    "abc480",
    "CODER",
    1
  );
  assert.equal(result.more, true);
  assert.equal(result.submissions.length, 1);
  const submission = result.submissions[0];
  assert.equal(submission.id, "80223806");
  assert.equal(submission.taskId, "abc480_a");
  assert.equal(submission.submittedAt, Date.parse("2026-10-20T15:50:33Z") / 1000);
  assert.equal(submission.language, "C++23 (GCC 15.2.0)");
  assert.equal(submission.status, Status.WrongAnswer);
  assert.equal(submission.points, 0);
  assert.equal(submission.time, 0);
  assert.equal(submission.memory, 1616 * 1024);
  assert.equal(submission.url, "https://atcoder.jp/contests/abc480/submissions/80223806");
  const ce = parseAtcoderSubmissionPage(html([row({ verdict: "CE", exec: "-", memory: "-" })]), "abc480", "coder", 1)
    .submissions[0];
  assert.equal(ce.status, Status.CompilationError);
  assert.equal(ce.time, null);
  assert.equal(ce.memory, null);
});

test("login, challenge and malformed result pages cannot masquerade as an empty successful sync", () => {
  assert.throws(
    () => parseAtcoderSubmissionPage('<form action="/login"><input name="password"></form>', "abc480", "coder", 1),
    /REMOTE_AUTH_REQUIRED/
  );
  assert.throws(
    () => parseAtcoderSubmissionPage("<html>Checking your browser</html>", "abc480", "coder", 1),
    /REMOTE_PARSE_FAILED/
  );
  assert.throws(
    () => parseAtcoderSubmissionPage(html([row({ time: "invalid" })]), "abc480", "coder", 1),
    /REMOTE_PARSE_FAILED/
  );
  assert.throws(
    () => parseAtcoderSubmissionPage(html([row({ contest: "abc481" })]), "abc480", "coder", 1),
    /REMOTE_PARSE_FAILED/
  );
  assert.equal(parseAtcoderSubmissionPage(html(), "abc480", "coder", 1).submissions.length, 0);
});

test("parser failures identify the contest, page, submission and invalid field without retaining HTML", () => {
  for (const [body, reason, id] of [
    ["<html>private-session browser verification</html>", "MISSING_SUBMISSION_TABLE"],
    ["<table><thead><tr><th>unexpected</th></tr></thead></table>", "UNEXPECTED_TABLE_HEADERS"],
    [html([row({ id: 123, time: "invalid" })]), "INVALID_SUBMISSION_TIME", "123"],
    [html([row({ id: 123, contest: "abc481" })]), "INVALID_TASK_LINK", "123"],
    [html([row({ id: 123, verdict: "" })]), "MISSING_VERDICT", "123"]
  ]) {
    assert.throws(
      () => parseAtcoderSubmissionPage(body, "abc480", "coder", 3),
      error => {
        assert.equal(error.message, "REMOTE_PARSE_FAILED");
        assert.equal(error.details.stage, "parse");
        assert.equal(error.details.reason, reason);
        assert.equal(error.details.contestId, "abc480");
        assert.equal(error.details.page, 3);
        assert.equal(error.details.submissionId, id);
        assert.doesNotMatch(JSON.stringify(error), /private-session|<html>|<table>/);
        return true;
      }
    );
  }
});

test("AtCoder JSON access denial carries the contest into diagnostics without requesting HTML", async () => {
  const { provider } = fixture();
  let requests = 0;
  global.fetch = async () => {
    requests++;
    return new Response("private upstream body", { status: 403 });
  };
  await assert.rejects(provider.getPage(account, targets), error => {
    assert.equal(error.message, "REMOTE_ACCESS_DENIED");
    const { request, ...details } = error.details;
    assert.deepEqual(details, { stage: "request", httpStatus: 403, contestId: "abc480" });
    assert.equal(request.url, "https://atcoder.jp/contests/abc480/submissions/me/status/json");
    assert.match(request.command, /Accept: application\/json/);
    assert.doesNotMatch(JSON.stringify(error), /private upstream|test-dedicated-session/);
    return true;
  });
  assert.equal(requests, 1);
});

test("request diagnostics reject credentials, arbitrary endpoints and command injection", () => {
  const url = "https://atcoder.jp/contests/abc480/submissions?f.User=coder&lang=en&page=1";
  for (const unsafe of [
    url.replace("atcoder.jp", "example.com"),
    url.replace("https://", "https://user:private@"),
    `${url}&session=private`,
    `${url}#private`,
    url.replace("coder&", "coder%27%3B%20echo%20private&"),
    "https://atcoder.jp/settings"
  ]) {
    assert.deepEqual(safeRemoteErrorDetails({ request: { url: unsafe, command: "private" } }), {});
  }
  const details = safeRemoteErrorDetails({ request: { url, command: "private raw command", cookie: "private" } });
  assert.equal(details.request.url, url);
  assert.doesNotMatch(JSON.stringify(details), /private/);
  assert.deepEqual(safeRemoteErrorDetails(details), details);
});

test("without a configured session or watched contest no upstream requests are sent", async () => {
  const { provider, calls } = fixture(() => "[]");
  personalSession = undefined;
  await assert.rejects(provider.getPage(account, targets), /REMOTE_AUTH_REQUIRED/);
  personalSession = "test-session";
  await provider.getPage(account, []);
  assert.equal(calls.length, 0);
});

test("HTTP failures distinguish access denial and rate limits without assuming a CAPTCHA", async () => {
  const { provider } = fixture();
  for (const [status, error] of [
    [403, "REMOTE_ACCESS_DENIED"],
    [429, "REMOTE_RATE_LIMITED"],
    [503, "REMOTE_UNAVAILABLE"]
  ]) {
    global.fetch = async () => new Response("", { status });
    await assert.rejects(
      provider.getPage({ platform: Method.Codeforces, handle: "coder", cursor: "0" }),
      new RegExp(error)
    );
  }
  global.fetch = async () => new Response("<html>Verification</html>", { status: 200 });
  await assert.rejects(
    provider.getPage({ platform: Method.Codeforces, handle: "coder", cursor: "0" }),
    /REMOTE_VERIFICATION_REQUIRED/
  );
});

test("session cookies only reach the original HTTPS host and redirects are never followed", async () => {
  const { provider } = fixture();
  const authenticated = address => provider.request(Method.AtCoder, address, true, undefined, 1, personalSession);
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response("[]", { status: 200 });
  };
  await authenticated("https://atcoder.jp/contests/abc480/submissions");
  await provider.request(Method.AtCoder, "https://atcoder.jp/users/coder");
  assert.equal(requests[0].options.headers.Cookie, "REVEL_SESSION=test-dedicated-session");
  assert.equal(requests[0].options.redirect, "manual");
  assert.equal(requests[1].options.headers.Cookie, undefined);
  await assert.rejects(authenticated("https://atcoder.jp.evil.test/"), /REMOTE_AUTH_REQUIRED/);
  await assert.rejects(authenticated("http://atcoder.jp/"), /REMOTE_AUTH_REQUIRED/);
  await assert.rejects(
    provider.request(Method.AtCoder, "https://atcoder.jp/", true, undefined, 1),
    /REMOTE_AUTH_REQUIRED/
  );
  assert.equal(requests.length, 2);
  await assert.rejects(provider.request(Method.AtCoder, "https://kenkoooo.com/atcoder/test"), /REMOTE_UNAVAILABLE/);
  assert.equal(requests.length, 2);
  global.fetch = async () => new Response("", { status: 302, headers: { location: "/login?continue=test" } });
  await assert.rejects(authenticated("https://atcoder.jp/contests/abc480/submissions"), /REMOTE_AUTH_REQUIRED/);
  global.fetch = async () => new Response("", { status: 302, headers: { location: "https://evil.test/" } });
  personalSession = "test-replaced-session";
  await assert.rejects(authenticated("https://atcoder.jp/contests/abc480/submissions"), /REMOTE_UNAVAILABLE/);
  personalSession = "invalid; injected=value";
  await assert.rejects(authenticated("https://atcoder.jp/"), /REMOTE_AUTH_REQUIRED/);
});

test("explicit HTTP and HTML challenges have a distinct error and do not advance result checkpoints", async () => {
  for (const [status, headers, body] of [
    [200, { "cf-mitigated": "challenge" }, "private verification body"],
    [403, { "cf-mitigated": "challenge" }, "private verification body"],
    [200, {}, '<title>Just a moment...</title><form id="challenge-form"></form>']
  ]) {
    const { provider, values } = fixture();
    global.fetch = async () => new Response(body, { status, headers });
    await assert.rejects(provider.getPage(account, targets), error => {
      assert.equal(error.message, "REMOTE_VERIFICATION_REQUIRED");
      assert.equal(error.details.reason, "CHALLENGE_PAGE");
      assert.equal(error.details.httpStatus, status);
      assert.equal(error.details.contestId, "abc480");
      assert.equal(error.details.page, undefined);
      assert.doesNotMatch(JSON.stringify(error), /private verification|test-dedicated-session|<form/);
      return true;
    });

    assert.equal(values.has("remote-atcoder-pages:1:abc480"), false);
    assert.ok((await provider.getAtcoderSessionContext(1)).cooldownMs > 0);
  }
});

test("a queued request from a second backend sees the cooldown before making another upstream request", async () => {
  const { provider } = fixture();
  let tail = Promise.resolve();
  provider.lockService = {
    lock: (_, fn) => {
      const result = tail.then(fn);
      tail = result.catch(() => {});
      return result;
    }
  };
  const second = Object.assign(Object.create(RemoteProviderService.prototype), {
    redisService: provider.redisService,
    atcoderSessions: provider.atcoderSessions,
    lockService: provider.lockService
  });
  let release;
  let entered;
  const started = new Promise(resolve => {
    entered = resolve;
  });
  let requests = 0;
  global.fetch = async () => {
    requests++;
    entered();
    await new Promise(resolve => {
      release = resolve;
    });
    return new Response("", { status: 403, headers: { "cf-mitigated": "challenge" } });
  };
  const first = provider.getPage(account, targets);
  await started;
  const next = second.getPage({ ...account, id: 2 }, targets);
  release();
  const outcomes = await Promise.allSettled([first, next]);
  assert.deepEqual(
    outcomes.map(outcome => outcome.reason?.message),
    ["REMOTE_VERIFICATION_REQUIRED", "REMOTE_COOLDOWN"]
  );
  assert.equal(requests, 1);
});

function statusJson(ids, verdict = "AC") {
  return JSON.stringify({
    Result: Object.fromEntries(
      ids.map(id => [
        id,
        {
          Html: `<td><span>${verdict}</span></td>${verdict === "WJ" ? "" : "<td>12 ms</td><td>1,024 KiB</td>"}`,
          Score: verdict === "AC" ? "100" : "0"
        }
      ])
    )
  });
}

test("a task context cannot authenticate another account or bypass a cooldown started after preparation", async () => {
  const { provider, expirations } = fixture();
  const context = await provider.getAtcoderSessionContext(account.id);
  let requests = 0;
  global.fetch = async () => {
    requests++;
    return new Response(html([row()]));
  };
  await assert.rejects(provider.getPage({ ...account, id: 2 }, targets, context), /REMOTE_AUTH_REQUIRED/);
  await assert.rejects(
    provider.getAtcoderSource({ id: "321", contestId: "abc480", taskId: "abc480_a", handle: "coder" }, 2, context),
    /REMOTE_AUTH_REQUIRED/
  );
  expirations.set(provider.atcoderCooldownKey(context.session), Date.now() + 60000);
  assert.equal(context.cooldownMs, 0);
  await assert.rejects(provider.getPage(account, targets, context), /REMOTE_COOLDOWN/);
  assert.equal(requests, 0);
});

test("status parser validates JSON, verdicts, scores and resources without accepting foreign metadata", () => {
  const { parseAtcoderStatuses } = require("../dist/remote-judge/atcoder-status.parser");
  const known = parseAtcoderSubmissionPage(html([row({ verdict: "WJ" })]), "abc480", "coder", 1).submissions;
  for (const body of [
    "<html>unknown</html>",
    "{",
    "{}",
    '{"Result":[]}',
    JSON.stringify({ Result: { [known[0].id]: { Html: "<td>unexpected</td>", Score: "100" } } }),
    JSON.stringify({ Result: { [known[0].id]: { Html: "<td>AC</td><td>bad resource</td>", Score: "100" } } }),
    JSON.stringify({ Result: { [known[0].id]: { Html: "<td>AC</td>", Score: "NaN" } } })
  ]) {
    assert.throws(() => parseAtcoderStatuses(body, known), /REMOTE_ATCODER_STATUS_FAILED/);
  }
  assert.deepEqual(parseAtcoderStatuses('{"Result":{}}', known), []);
  assert.equal(parseAtcoderStatuses(statusJson([known[0].id], "WJ"), known)[0].status, Status.Pending);
  assert.equal(known[0].status, Status.Pending);
});

function longRunningStatus(verdict, finished = false) {
  return JSON.stringify({
    Result: {
      80271618: {
        Html: finished
          ? "<td class='text-center'><span class='label label-warning' title='Time Limit Exceeded'>TLE</span></td><td class='text-right'>&gt; 2000 ms</td><td class='text-right'>1616 KiB</td>"
          : `<td colspan='3' class='text-center waiting-judge' data-id='80271618'><span class='label label-warning' title='Time Limit Exceeded'>${verdict}</span></td>`,
        Score: "0"
      }
    }
  });
}

test("HTML fallback accepts progress verdicts and greater-than resource displays too", () => {
  const pending = parseAtcoderSubmissionPage(html([row({ verdict: "6/26 TLE" })]), "abc480", "coder", 1);
  assert.equal(pending.submissions[0].status, Status.Pending);
  const final = parseAtcoderSubmissionPage(html([row({ verdict: "TLE", exec: "&gt; 2000 ms" })]), "abc480", "coder", 1);
  assert.equal(final.submissions[0].status, Status.TimeLimitExceeded);
  assert.equal(final.submissions[0].time, 2000);
});

test("the waiting-judge marker prevents a provisional terminal verdict from being finalized", () => {
  const { parseAtcoderStatusResponse } = require("../dist/remote-judge/atcoder-status.parser");
  const [result] = parseAtcoderStatusResponse(longRunningStatus("TLE"));
  assert.equal(result.verdict, "TLE");
  assert.equal(result.status, Status.Pending);
});

const { parseAtcoderSubmissionDetail } = require("../dist/remote-judge/atcoder-detail.parser");
function detail({
  id = "321",
  contest = "abc480",
  user = "coder",
  time = "2026-10-21 00:50:33+0900",
  language = "C++23 (GCC 15.2.0)",
  code = "// private source\r\nint main() { return 1 < 2; }\n"
} = {}) {
  const escape = value => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<h2>Submission #${id}</h2><form action="/logout?continue=%2F"></form>
  <table><tr><th>Submission Time</th><td><time>${time}</time></td></tr>
  <tr><th>Task</th><td><a href="/contests/${contest}/tasks/${contest}_a">Task</a></td></tr>
  <tr><th>User</th><td><a href="/users/${user}">${user}</a></td></tr>
  <tr><th>Language</th><td>${language}</td></tr></table>
  ${code === null ? "" : `<pre id="submission-code">${escape(code)}</pre>`}`;
}
const detailCalls = calls => calls.filter(call => !/\/status\/json$/.test(call.url.pathname));
const noLists = calls =>
  assert.ok(calls.every(call => /\/submissions\/(?:[1-9]\d*|me\/status\/json)$/.test(call.url.pathname)));

test("detail parsing establishes ID, task, author, language and original JST time and preserves source bytes", () => {
  const row = parseAtcoderSubmissionDetail(detail(), { id: "321", contestId: "abc480", handle: "CODER" });
  assert.equal(row.taskId, "abc480_a");
  assert.equal(row.submittedAt, Date.parse("2026-10-20T15:50:33Z") / 1000);
  assert.equal(row.language, "C++23 (GCC 15.2.0)");
  assert.equal(row.sourceCode, "// private source\r\nint main() { return 1 < 2; }\n");
  for (const change of [
    { id: "322" },
    { contest: "abc481" },
    { user: "someone" },
    { time: "invalid" },
    { language: "" }
  ])
    assert.throws(
      () => parseAtcoderSubmissionDetail(detail(change), { id: "321", contestId: "abc480", handle: "coder" }),
      /REMOTE_/
    );
  const missing = parseAtcoderSubmissionDetail(detail({ code: null }), {
    id: "321",
    contestId: "abc480",
    handle: "coder"
  });
  assert.equal(missing.sourceCode, undefined);
  const japanese = detail().replace("Submission Time", "提出日時").replace("Language", "言語");
  assert.equal(
    parseAtcoderSubmissionDetail(japanese, { id: "321", contestId: "abc480", handle: "coder" }).submittedAt,
    row.submittedAt
  );
});

test("pending JSON IDs request no HTML; the first final JSON result requests details in the same turn", async () => {
  let verdict = "WJ";
  const { provider, calls, values } = fixture(
    () => detail(),
    () => statusJson(["321"], verdict)
  );
  let result = await provider.getPage(account, targets);
  assert.deepEqual(result.submissions, []);
  assert.equal(result.pending, true);
  assert.equal(detailCalls(calls).length, 0);
  assert.equal(values.has("remote-atcoder-pages:1:abc480"), false);
  await result.acknowledge();
  verdict = "AC";
  result = await provider.getPage(account, targets);
  assert.equal(result.pending, false);
  assert.equal(detailCalls(calls).length, 1);
  assert.equal(result.submissions[0].id, "321");
  assert.equal(result.submissions[0].status, Status.Accepted);
  assert.equal(result.submissions[0].points, 100);
  assert.match(result.submissions[0].sourceCode, /private source/);
  await result.acknowledge();
  assert.doesNotMatch(values.get("remote-atcoder-pages:1:abc480"), /private source|sourceCode|test-dedicated-session/);
  const again = await provider.getPage(account, targets);
  assert.equal(again.submissions[0].sourceCode, undefined);
  assert.equal(detailCalls(calls).length, 1);
  noLists(calls);
});

test("long-running progress including provisional TLE waits for a terminal JSON response before reading details", async () => {
  let finished = false;
  const { provider, calls } = fixture(
    () => detail({ id: "80271618" }),
    () => longRunningStatus("6/26 TLE", finished)
  );
  let result = await provider.getPage(account, targets);
  assert.equal(result.pending, true);
  assert.equal(detailCalls(calls).length, 0);
  await result.acknowledge();
  finished = true;
  result = await provider.getPage(account, targets);
  assert.equal(result.submissions[0].status, Status.TimeLimitExceeded);
  assert.equal(result.submissions[0].points, 0);
  assert.equal(result.submissions[0].time, 2000);
  assert.equal(detailCalls(calls).length, 1);
  noLists(calls);
});

test("empty JSON discovery requests no list or detail, and later new final IDs fetch their own detail", async () => {
  let ids = [];
  const { provider, calls } = fixture(
    () => detail(),
    () => statusJson(ids)
  );
  for (let i = 0; i < 3; i++) {
    const result = await provider.getPage(account, targets);
    assert.deepEqual(result.submissions, []);
    assert.equal(result.pending, false);
    await result.acknowledge();
  }
  assert.equal(detailCalls(calls).length, 0);
  ids = ["321"];
  const result = await provider.getPage(account, targets);
  assert.equal(result.submissions[0].id, "321");
  assert.equal(detailCalls(calls).length, 1);
  noLists(calls);
});

test("invalid JSON never falls back to a submission list", async () => {
  const { provider, calls } = fixture(
    () => {
      throw Error("Unexpected HTML request");
    },
    () => "<html>not JSON</html>"
  );
  await assert.rejects(provider.getPage(account, targets), error => {
    assert.equal(error.message, "REMOTE_ATCODER_STATUS_FAILED");
    assert.match(error.details.request.url, /\/status\/json$/);
    return true;
  });
  assert.equal(calls.length, 1);
  noLists(calls);
});

test("detail parse errors retain a sanitized reproduction command and retry without losing the final JSON grade", async () => {
  let body = "<html>private upstream body</html>";
  const { provider, calls, values } = fixture(
    () => body,
    () => statusJson(["321"])
  );
  let result = await provider.getPage(account, targets);
  assert.equal(result.submissions.length, 0);
  assert.equal(result.pending, true);
  assert.equal(result.warning.error, "REMOTE_PARSE_FAILED");
  const diagnostics = safeRemoteErrorDetails(result.warning.details);
  assert.equal(diagnostics.submissionId, "321");
  assert.equal(diagnostics.request.url, "https://atcoder.jp/contests/abc480/submissions/321");
  assert.ok(diagnostics.request.command.includes(`--user-agent '${ATCODER_USER_AGENT}'`));
  assert.match(diagnostics.request.command, /REVEL_SESSION=\$ATCODER_REVEL_SESSION/);
  assert.doesNotMatch(JSON.stringify(diagnostics), /private upstream|test-dedicated-session/);
  const { spawnSync } = require("node:child_process");
  const replay = spawnSync("sh", ["-c", `curl() { printf '%s\\n' "$@"; }; ${diagnostics.request.command}`], {
    encoding: "utf8",
    env: { ...process.env, ATCODER_REVEL_SESSION: "local-session" }
  });
  assert.equal(replay.status, 0);
  assert.match(replay.stdout, /REVEL_SESSION=local-session/);
  await result.acknowledge();
  result = await provider.getPage(account, targets);
  assert.equal(detailCalls(calls).length, 1);
  await result.acknowledge();
  const state = JSON.parse(values.get("remote-atcoder-pages:1:abc480"));
  state.discoveries["321"].retryAt = 0;
  values.set("remote-atcoder-pages:1:abc480", JSON.stringify(state));
  body = detail();
  // Even if the next JSON snapshot omits the ID, its saved final result remains retryable.
  const original = provider.request;
  provider.request = (platform, address, ...args) =>
    new URL(address).pathname.endsWith("/status/json")
      ? Promise.resolve(statusJson([]))
      : original(platform, address, ...args);
  result = await provider.getPage(account, targets);
  assert.equal(result.submissions[0].id, "321");
  assert.equal(result.submissions[0].points, 100);
  noLists(calls);
});

test("a bounded detail batch eventually imports all finals, retains same-second IDs and does not refetch evicted metadata", async () => {
  const ids = Array.from({ length: 205 }, (_, i) => String(i + 1));
  const { provider, calls, values } = fixture(
    url => detail({ id: url.pathname.split("/").at(-1) }),
    () => statusJson(ids)
  );
  const received = [];
  let done = false;
  for (let turn = 0; turn < 45; turn++) {
    const before = detailCalls(calls).length;
    const result = await provider.getPage(account, targets);
    assert.ok(detailCalls(calls).length - before <= 5);
    received.push(...result.submissions.filter(row => row.sourceCode).map(row => row.id));
    await result.acknowledge();
    if (!result.pending) {
      done = true;
      break;
    }
  }
  assert.equal(done, true);
  assert.equal(new Set(received).size, 205);
  assert.equal(detailCalls(calls).length, 205);
  assert.equal(JSON.parse(values.get("remote-atcoder-pages:1:abc480")).knownRows.length, 200);
  await provider.getPage(account, targets);
  assert.equal(detailCalls(calls).length, 205);
  noLists(calls);
});

test("legacy unresolved IDs below the old boundary still fetch details when JSON confirms they are final", async () => {
  const { provider, calls, values } = fixture(
    () => detail({ id: "38" }),
    () => statusJson(["38"])
  );
  values.set("remote-atcoder-pages:1:abc480", JSON.stringify({ page: 9, head: 40, boundary: 40, pendingIds: ["38"] }));
  const result = await provider.getPage(account, targets);
  assert.equal(result.submissions[0].id, "38");
  assert.equal(result.pending, false);
  await result.acknowledge();
  assert.deepEqual(JSON.parse(values.get("remote-atcoder-pages:1:abc480")).pendingIds, []);
  noLists(calls);
});

test("migrated pending records keep their verified metadata when JSON temporarily omits the ID", async () => {
  const known = parseAtcoderSubmissionPage(html([row({ id: 321, verdict: "WJ" })]), "abc480", "coder", 1)
    .submissions[0];
  const { provider, calls, values } = fixture(
    () => detail(),
    () => statusJson([])
  );
  values.set(
    "remote-atcoder-pages:1:abc480",
    JSON.stringify({ page: 2, head: 0, boundary: 321, pendingIds: ["321"], pendingRows: [known] })
  );
  const result = await provider.getPage(account, targets);
  assert.equal(result.pending, true);
  assert.equal(result.submissions.length, 0);
  assert.equal(detailCalls(calls).length, 0);
  noLists(calls);
});

test("contest rotation keeps outstanding pending IDs from other contests", async () => {
  const { provider, calls } = fixture(
    url => detail({ contest: url.pathname.split("/")[2] }),
    url => statusJson(["321"], url.pathname.includes("abc480") ? "WJ" : "AC")
  );
  const all = [...targets, { contestId: "abc481", since: 0 }];
  let result = await provider.getPage(account, all);
  await result.acknowledge();
  result = await provider.getPage(account, all);
  assert.equal(result.submissions[0].contestId, "abc481");
  assert.equal(result.pending, true);
  noLists(calls);
});

test("missing source does not discard verified grades and source is not retried by the result poller", async () => {
  const { provider, calls } = fixture(
    () => detail({ code: null }),
    () => statusJson(["321"])
  );
  const first = await provider.getPage(account, targets);
  assert.equal(first.submissions[0].points, 100);
  assert.equal(first.submissions[0].sourceCode, undefined);
  await first.acknowledge();
  const second = await provider.getPage(account, targets);
  assert.equal(second.submissions[0].points, 100);
  assert.equal(detailCalls(calls).length, 1);
});

test("a failed import leaves the detail unacknowledged so it can be retried without exposing source in Redis", async () => {
  const { provider, values, calls } = fixture(
    () => detail(),
    () => statusJson(["321"])
  );
  await provider.getPage(account, targets);
  assert.equal(values.has("remote-atcoder-pages:1:abc480"), false);
  const next = await provider.getPage(account, targets);
  assert.equal(detailCalls(calls).length, 2);
  await next.acknowledge();
  assert.doesNotMatch(JSON.stringify([...values]), /private source|sourceCode/);
});

test("shared personal cooldown blocks other accounts and source fetches until the session is replaced", async () => {
  const { provider } = fixture();
  let requests = 0;
  global.fetch = async () => {
    requests++;
    return new Response("", { status: 429, headers: { "retry-after": "120" } });
  };
  await assert.rejects(provider.getPage(account, targets), /REMOTE_RATE_LIMITED/);
  assert.ok((await provider.getAtcoderSessionContext(1)).cooldownMs > 119000);
  await assert.rejects(provider.getPage({ ...account, id: 2 }, targets), /REMOTE_COOLDOWN/);
  await assert.rejects(
    provider.getAtcoderSource({ id: "321", contestId: "abc480", taskId: "abc480_a", handle: "coder" }, 1),
    /REMOTE_COOLDOWN/
  );
  assert.equal(requests, 1);
  personalSession = "replacement-session";
  global.fetch = async () => {
    requests++;
    return new Response(statusJson([]));
  };
  await provider.getPage(account, targets);
  assert.equal(requests, 2);
});

test("one turn reuses its personal credential for JSON and detail requests and reloads on the next turn", async () => {
  const { provider } = fixture();
  let reads = 0;
  const cookies = [];
  provider.atcoderSessions = {
    get: async () => {
      reads++;
      return "personal-session";
    }
  };
  global.fetch = async (address, options) => {
    cookies.push(options.headers.Cookie);
    return new Response(new URL(address).pathname.endsWith("/status/json") ? statusJson(["321"]) : detail());
  };
  const first = await provider.getPage(account, targets);
  await first.acknowledge();
  assert.equal(reads, 1);
  assert.equal(cookies.length, 2);
  await provider.getPage(account, targets);
  assert.equal(reads, 2);
  assert.ok(cookies.every(cookie => cookie === "REVEL_SESSION=personal-session"));
});

test("a failed lower ID remains retryable after a higher ID advances the completed boundary", async () => {
  let failed = true;
  let ids = ["321", "322"];
  const { provider, values } = fixture(
    url => {
      const id = url.pathname.split("/").at(-1);
      return failed && id === "321" ? "<html>unexpected</html>" : detail({ id });
    },
    () => statusJson(ids)
  );
  const first = await provider.getPage(account, targets);
  assert.deepEqual(
    first.submissions.map(row => row.id),
    ["322"]
  );
  await first.acknowledge();
  const scan = JSON.parse(values.get("remote-atcoder-pages:1:abc480"));
  assert.equal(scan.boundary, 322);
  scan.discoveries["321"].retryAt = 0;
  values.set("remote-atcoder-pages:1:abc480", JSON.stringify(scan));
  failed = false;
  ids = [];
  const next = await provider.getPage(account, targets);
  assert.equal(next.submissions[0].id, "321");
  assert.equal(next.pending, false);
});

test("detail challenges pause the personal session and retain diagnostics without committing the checkpoint", async () => {
  const { provider, values } = fixture();
  const urls = [];
  global.fetch = async address => {
    const url = new URL(address);
    urls.push(url);
    return url.pathname.endsWith("/status/json")
      ? new Response(statusJson(["321"]))
      : new Response("private challenge body", { status: 403, headers: { "cf-mitigated": "challenge" } });
  };
  await assert.rejects(provider.getPage(account, targets), error => {
    assert.equal(error.message, "REMOTE_VERIFICATION_REQUIRED");
    assert.equal(error.details.submissionId, "321");
    assert.match(error.details.request.url, /\/submissions\/321$/);
    assert.doesNotMatch(JSON.stringify(error), /private challenge body|test-dedicated-session/);
    return true;
  });
  assert.equal(values.has("remote-atcoder-pages:1:abc480"), false);
  assert.ok((await provider.getAtcoderSessionContext(1)).cooldownMs > 0);
  assert.equal(urls.length, 2);
});

test("a detail-only access denial backs off that ID without blocking other final submissions", async () => {
  const { provider, values } = fixture(
    url => {
      const id = url.pathname.split("/").at(-1);
      if (id === "321") throw new Error("REMOTE_ACCESS_DENIED");
      return detail({ id });
    },
    () => statusJson(["321", "322"])
  );
  const result = await provider.getPage(account, targets);
  assert.equal(result.warning.error, "REMOTE_ACCESS_DENIED");
  assert.deepEqual(
    result.submissions.map(row => row.id),
    ["322"]
  );
  await result.acknowledge();
  const scan = JSON.parse(values.get("remote-atcoder-pages:1:abc480"));
  assert.ok(scan.discoveries["321"].retryAt > Date.now());
  assert.equal(scan.discoveries["322"], undefined);
});
