const assert = require("node:assert/strict");
const { test, beforeEach, afterEach } = require("node:test");
const path = require("node:path");
require("reflect-metadata");
require("tsconfig-paths").register({ baseUrl: path.resolve(__dirname, "../dist"), paths: { "@/*": ["*"] } });
const { RemoteProviderService } = require("../dist/remote-judge/remote-provider.service");
const { parseAtcoderSubmissionPage } = require("../dist/remote-judge/atcoder-submission.parser");
const { SubmissionMethod: Method } = require("../dist/remote-judge/remote-judge.types");
const { SubmissionStatus: Status } = require("../dist/submission/submission-status.enum");

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
function fixture(handler) {
  process.env.NSOJ_ATCODER_SESSION = "test-dedicated-session";
  const values = new Map();
  const calls = [];
  const provider = Object.create(RemoteProviderService.prototype);
  const checks = [];
  provider.siteSettingService = {
    getAtcoderSession: async () => process.env.NSOJ_ATCODER_SESSION?.trim(),
    recordAtcoderSessionCheck: async (session, error) => checks.push({ session, error })
  };
  provider.redisService = {
    getClient: () => ({
      get: async key => values.get(key) ?? null,
      set: async (key, value) => {
        values.set(key, value);
        return "OK";
      },
      pttl: async () => 0
    })
  };
  provider.lockService = { lock: async (_, fn) => fn() };
  if (handler)
    provider.request = async (platform, address, authenticated) => {
      const url = new URL(address);
      calls.push({ url, authenticated });
      assert.equal(url.origin, "https://atcoder.jp", "AtCoder sync must never contact third-party services");
      return handler(url, authenticated);
    };
  return { provider, values, calls, checks };
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

test("results come exclusively from AtCoder, with deferred checkpoints", async () => {
  const { provider, values, calls, checks } = fixture(() => html([row()]));
  const result = await provider.getPage(account, targets);
  assert.equal(result.submissions[0].id, "80223806");
  assert.equal(result.submissions[0].status, Status.WrongAnswer);
  assert.equal(result.cursor, account.cursor);
  assert.equal(values.has("remote-atcoder-pages:1:abc480"), false);
  await result.acknowledge();
  assert.equal(JSON.parse(values.get("remote-atcoder-pages:1:abc480")).boundary, 80223806);
  assert.equal(calls[0].url.hostname, "atcoder.jp");
  assert.equal(calls[0].url.searchParams.get("f.User"), "coder");
  assert.equal(calls[0].url.searchParams.get("lang"), "en");
  assert.equal(calls[0].authenticated, true);
  assert.equal(calls.length, 1);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].error, undefined);
});

test("distinct submissions in the same second are retained and overlapping IDs are deduplicated", async () => {
  const { provider } = fixture(() => html([row({ id: 10, verdict: "AC" }), row({ id: 11 }), row({ id: 11 })]));
  const result = await provider.getPage(account, targets);
  assert.deepEqual(
    result.submissions.map(item => item.id),
    ["10", "11"]
  );
  assert.equal(result.submissions[0].submittedAt, result.submissions[1].submittedAt);
  assert.equal(result.pending, false);
  assert.equal(result.cursor, account.cursor);
});

test("expired sessions, access failures, rate limits and verification pages never fall back to a third party", async () => {
  for (const code of ["REMOTE_AUTH_REQUIRED", "REMOTE_UNAVAILABLE", "REMOTE_RATE_LIMITED", "REMOTE_PARSE_FAILED"]) {
    const { provider, calls, values, checks } = fixture(() => {
      throw new Error(code);
    });
    await assert.rejects(provider.getPage(account, targets), error => error.message === code);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url.origin, "https://atcoder.jp");
    assert.equal(values.has("remote-atcoder-pages:1:abc480"), false);
    assert.equal(checks[0].error, code);
  }
});

test("large bursts are scanned over bounded turns while page one continues to refresh", async () => {
  const pages = [];
  const { provider } = fixture(url => {
    if (url.hostname !== "atcoder.jp") return "[]";
    const page = Number(url.searchParams.get("page"));
    pages.push(page);
    const ids = page === 1 ? [30, 29] : page === 2 ? [28, 27] : [26, 25];
    return html(
      ids.map(id => row({ id })),
      { page, more: page < 3 }
    );
  });
  let result = await provider.getPage(account, targets);
  assert.equal(result.pending, true);
  await result.acknowledge();
  result = await provider.getPage(account, targets);
  assert.equal(result.pending, false);
  await result.acknowledge();
  result = await provider.getPage(account, targets);
  await result.acknowledge();
  assert.deepEqual(pages, [1, 2, 1, 3, 1]);
});

test("pending judgements behind page one are revisited until they become final", async () => {
  let finished = false;
  const { provider } = fixture(url => {
    if (url.hostname !== "atcoder.jp") return "[]";
    const page = Number(url.searchParams.get("page"));
    return html(
      page === 1
        ? [row({ id: 40 }), row({ id: 39 })]
        : [row({ id: 38, verdict: finished ? "AC" : "WJ" }), row({ id: 37 })],
      { page, more: page === 1 }
    );
  });
  let result = await provider.getPage(account, targets);
  assert.equal(result.pending, true);
  await result.acknowledge();
  finished = true;
  result = await provider.getPage(account, targets);
  assert.equal(result.pending, false);
  assert.equal(result.submissions.find(item => item.id === "38").status, Status.Accepted);
  await result.acknowledge();
});

test("contest rotation preserves outstanding results from other contests", async () => {
  let finished = false;
  const { provider, calls } = fixture(url => {
    if (url.hostname !== "atcoder.jp") return "[]";
    const contest = url.pathname.split("/")[2];
    return html([row({ contest, verdict: contest === "abc480" && !finished ? "WJ" : "AC" })], { contest });
  });
  const multiple = [...targets, { contestId: "abc481", since: targets[0].since }];
  let result = await provider.getPage(account, multiple);
  assert.equal(result.pending, true);
  await result.acknowledge();
  result = await provider.getPage(account, multiple);
  assert.equal(result.pending, true);
  await result.acknowledge();
  finished = true;
  result = await provider.getPage(account, multiple);
  assert.equal(result.pending, false);
  await result.acknowledge();
  assert.deepEqual(
    calls.filter(call => call.authenticated).map(call => call.url.pathname),
    ["/contests/abc480/submissions", "/contests/abc481/submissions", "/contests/abc480/submissions"]
  );
});

test("without a configured session or watched contest no upstream requests are sent", async () => {
  const { provider, calls } = fixture(() => "[]");
  delete process.env.NSOJ_ATCODER_SESSION;
  await assert.rejects(provider.getPage(account, targets), /REMOTE_AUTH_REQUIRED/);
  process.env.NSOJ_ATCODER_SESSION = "test-session";
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
    /REMOTE_API_FAILED/
  );
});

test("session cookies only reach the original HTTPS host and redirects are never followed", async () => {
  const { provider } = fixture();
  const requests = [];
  global.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response("[]", { status: 200 });
  };
  await provider.request(Method.AtCoder, "https://atcoder.jp/contests/abc480/submissions", true);
  await provider.request(Method.AtCoder, "https://atcoder.jp/users/coder");
  assert.equal(requests[0].options.headers.Cookie, "REVEL_SESSION=test-dedicated-session");
  assert.equal(requests[0].options.redirect, "manual");
  assert.equal(requests[1].options.headers.Cookie, undefined);
  await assert.rejects(provider.request(Method.AtCoder, "https://atcoder.jp.evil.test/", true), /REMOTE_AUTH_REQUIRED/);
  await assert.rejects(provider.request(Method.AtCoder, "http://atcoder.jp/", true), /REMOTE_AUTH_REQUIRED/);
  assert.equal(requests.length, 2);
  await assert.rejects(provider.request(Method.AtCoder, "https://kenkoooo.com/atcoder/test"), /REMOTE_UNAVAILABLE/);
  assert.equal(requests.length, 2);
  global.fetch = async () => new Response("", { status: 302, headers: { location: "/login?continue=test" } });
  await assert.rejects(
    provider.request(Method.AtCoder, "https://atcoder.jp/contests/abc480/submissions", true),
    /REMOTE_AUTH_REQUIRED/
  );
  global.fetch = async () => new Response("", { status: 302, headers: { location: "https://evil.test/" } });
  await assert.rejects(
    provider.request(Method.AtCoder, "https://atcoder.jp/contests/abc480/submissions", true),
    /REMOTE_UNAVAILABLE/
  );
  process.env.NSOJ_ATCODER_SESSION = "invalid; injected=value";
  await assert.rejects(provider.request(Method.AtCoder, "https://atcoder.jp/", true), /REMOTE_AUTH_REQUIRED/);
});
