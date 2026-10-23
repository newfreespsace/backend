const assert = require("node:assert/strict");
const { test, afterEach } = require("node:test");
const path = require("node:path");
require("reflect-metadata");
require("tsconfig-paths").register({ baseUrl: path.resolve(__dirname, "../dist"), paths: { "@/*": ["*"] } });
const { RemoteProviderService } = require("../dist/remote-judge/remote-provider.service");
const { parseAtcoderSubmissionPage } = require("../dist/remote-judge/atcoder-submission.parser");
const { SubmissionMethod: Method } = require("../dist/remote-judge/remote-judge.types");
const { SubmissionStatus: Status } = require("../dist/submission/submission-status.enum");

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
      if (url.pathname.endsWith("/status/json"))
        return statusHandler ? statusHandler(url) : JSON.stringify({ Result: {} });
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
    assert.deepEqual(error.details, { stage: "request", httpStatus: 403, contestId: "abc480" });
    assert.doesNotMatch(JSON.stringify(error), /private upstream|test-dedicated-session/);
    return true;
  });
  assert.equal(requests, 1);
});

test("results come exclusively from AtCoder, with deferred checkpoints", async () => {
  const { provider, values, calls } = fixture(() => html([row()]));
  const result = await provider.getPage(account, targets);
  assert.equal(result.submissions[0].id, "80223806");
  assert.equal(result.submissions[0].status, Status.WrongAnswer);
  assert.equal(result.cursor, account.cursor);
  assert.equal(values.has("remote-atcoder-pages:1:abc480"), false);
  await result.acknowledge();
  assert.equal(JSON.parse(values.get("remote-atcoder-pages:1:abc480")).boundary, 80223806);
  assert.equal(calls[0].url.hostname, "atcoder.jp");
  assert.ok(calls[0].url.pathname.endsWith("/status/json"));
  assert.equal(calls[0].url.search, "");
  assert.equal(calls[1].url.searchParams.get("f.User"), "coder");
  assert.equal(calls[1].url.searchParams.get("lang"), "en");
  assert.equal(calls[0].authenticated, true);
  assert.equal(calls.length, 2);
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
    const { provider, calls, values } = fixture(() => {
      throw new Error(code);
    });
    await assert.rejects(provider.getPage(account, targets), error => error.message === code);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].url.origin, "https://atcoder.jp");
    assert.equal(values.has("remote-atcoder-pages:1:abc480"), false);
  }
});

test("large bursts are scanned over bounded turns while page one continues to refresh", async () => {
  const pages = [];
  const { provider, values } = fixture(url => {
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
  assert.deepEqual(pages, [1, 2, 1, 3]);
});

test("pending judgements behind page one are revisited until they become final", async () => {
  let finished = false;
  const { provider, values } = fixture(url => {
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
  const saved = JSON.parse(values.get("remote-atcoder-pages:1:abc480"));
  saved.nextDiscoveryAt = 0;
  values.set("remote-atcoder-pages:1:abc480", JSON.stringify(saved));
  result = await provider.getPage(account, targets);
  assert.equal(result.pending, false);
  assert.equal(result.submissions.find(item => item.id === "38").status, Status.Accepted);
  await result.acknowledge();
});

test("contest rotation preserves outstanding results from other contests", async () => {
  let finished = false;
  const { provider, calls, values } = fixture(url => {
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
  const saved = JSON.parse(values.get("remote-atcoder-pages:1:abc480"));
  saved.nextDiscoveryAt = 0;
  values.set("remote-atcoder-pages:1:abc480", JSON.stringify(saved));
  result = await provider.getPage(account, multiple);
  assert.equal(result.pending, false);
  await result.acknowledge();
  assert.deepEqual(
    calls
      .filter(call => call.authenticated && !call.url.pathname.endsWith("/status/json"))
      .map(call => call.url.pathname),
    ["/contests/abc480/submissions", "/contests/abc481/submissions", "/contests/abc480/submissions"]
  );
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

function emptySearch({ contest = "abc480", user = "coder", message = "There is no submission." } = {}) {
  return `<title>All Submissions - AtCoder</title><div id="main-container">
    <a href="/logout?continue=%2F">Sign Out</a>
    <form method="GET" action="/contests/${contest}/submissions">
      <input name="f.User" value="${user}"><select name="f.Task"></select>
    </form><p>${message}</p></div>`;
}

test("authenticated empty search without a table is successful only with matching search context and explicit empty text", async () => {
  for (const message of ["There is no submission.", "No submissions found.", "提出がありません。"])
    assert.deepEqual(parseAtcoderSubmissionPage(emptySearch({ message }), "abc480", "coder", 1), {
      submissions: [],
      more: false
    });
  const valid = emptySearch();
  for (const body of [
    valid.replace("/logout?", "/login?"),
    emptySearch({ contest: "abc481" }),
    emptySearch({ user: "someone" }),
    emptySearch({ message: "Service unavailable" }),
    valid.replace('method="GET"', 'method="POST"'),
    valid.replace("/contests/abc480/submissions", "https://evil.test/contests/abc480/submissions"),
    valid.replace('action="/contests/abc480/submissions"', 'action="http://["'),
    `<p>There is no submission.</p>`,
    `<title>Just a moment...</title>${valid}`,
    `<form action="/login"><input name="password"></form>${valid}`
  ])
    assert.throws(
      () => parseAtcoderSubmissionPage(body, "abc480", "coder", 1),
      /REMOTE_(PARSE_FAILED|VERIFICATION_REQUIRED|AUTH_REQUIRED)/
    );
  const { provider, values } = fixture(() => valid);
  const result = await provider.getPage(account, targets);
  assert.equal(result.pending, false);
  assert.equal(values.has("remote-atcoder-pages:1:abc480"), false);
  await result.acknowledge();
  assert.equal(JSON.parse(values.get("remote-atcoder-pages:1:abc480")).page, 2);
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

test("shared session cooldown blocks other accounts and source fetches, expires, and is bypassed by a replacement session", async () => {
  const { provider, expirations } = fixture();
  let requests = 0;
  global.fetch = async () => {
    requests++;
    return new Response("", { status: 429, headers: { "retry-after": "120" } });
  };
  await assert.rejects(provider.getPage(account, targets), /REMOTE_RATE_LIMITED/);
  const pause = (await provider.getAtcoderSessionContext(1)).cooldownMs;
  assert.ok(pause > 119000 && pause <= 120000);
  const deadlines = [...expirations];
  await assert.rejects(provider.getPage({ ...account, id: 2 }, targets), /REMOTE_COOLDOWN/);
  await assert.rejects(
    provider.getAtcoderSource({ id: "123", contestId: "abc480", taskId: "abc480_a", handle: "coder" }, 1),
    /REMOTE_COOLDOWN/
  );
  assert.deepEqual([...expirations], deadlines, "waiting must not extend the cooldown");
  assert.equal(requests, 1);
  personalSession = "new-private-session";
  assert.equal((await provider.getAtcoderSessionContext(1)).cooldownMs, 0);
  global.fetch = async () => {
    requests++;
    return new Response(html([row()]));
  };
  await provider.getPage(account, targets);
  assert.equal(requests, 3);
  personalSession = "test-dedicated-session";
  for (const key of expirations.keys()) expirations.set(key, Date.now() - 1);
  await provider.getPage(account, targets);
  assert.equal(requests, 5);
});

test("login failures cool down the shared session but isolated 403s and malformed contest pages do not", async () => {
  for (const [status, body, expected, paused] of [
    [200, '<input name="password">', "REMOTE_AUTH_REQUIRED", true],
    [403, "", "REMOTE_ACCESS_DENIED", false],
    [200, "<html>unknown page</html>", "REMOTE_PARSE_FAILED", false]
  ]) {
    const { provider } = fixture();
    global.fetch = async () => new Response(body, { status });
    await assert.rejects(provider.getPage(account, targets), new RegExp(expected));
    assert.equal((await provider.getAtcoderSessionContext(1)).cooldownMs > 0, paused);
  }
});

test("ordinary Cloudflare browser detection and embedded Turnstile do not masquerade as challenge pages", async () => {
  const body = `<script src="/cdn-cgi/challenge-platform/h/g/jsd/oneshot"></script><div class="cf-turnstile"></div>${html(
    [row()]
  )}`;
  const { provider } = fixture();
  global.fetch = async () => new Response(body);
  assert.equal((await provider.getPage(account, targets)).submissions.length, 1);
  assert.equal((await provider.getAtcoderSessionContext(1)).cooldownMs, 0);
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

test("one worker turn shares its credential across list and status requests, then reloads it next turn", async () => {
  const { provider } = fixture();
  let reads = 0;
  let session = "private-first";
  provider.atcoderSessions = {
    get: async () => {
      reads++;
      return session;
    }
  };
  const cookies = [];
  global.fetch = async (address, options) => {
    cookies.push(options.headers.Cookie);
    return new Response(
      new URL(address).pathname.endsWith("/status/json") ? statusJson(["321"]) : html([row({ id: 321, verdict: "WJ" })])
    );
  };
  const context = await provider.getAtcoderSessionContext(account.id);
  const page = await provider.getPage(account, targets, context);
  assert.equal(page.submissions.at(-1).status, Status.Accepted);
  assert.equal(reads, 1);
  assert.deepEqual(cookies, ["REVEL_SESSION=private-first", "REVEL_SESSION=private-first"]);
  session = "private-replacement";
  await provider.getPage(account, targets);
  assert.equal(reads, 2);
  assert.ok(cookies.slice(2).every(cookie => cookie === "REVEL_SESSION=private-replacement"));
  session = undefined;
  await assert.rejects(provider.getPage(account, targets), /REMOTE_AUTH_REQUIRED/);
  assert.equal(reads, 3);
  assert.equal(cookies.length, 4);
});

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

test("known pending IDs poll JSON without refreshing the full list and stop at a final result", async () => {
  let verdict = "WJ";
  const { provider, calls, values } = fixture(
    () => html([row({ id: 321, verdict: "WJ" })]),
    () => statusJson(["321"], verdict)
  );
  let result = await provider.getPage(account, targets);
  assert.equal(result.pending, true);
  assert.equal(result.pollAfterMs, 5000);
  await result.acknowledge();
  verdict = "AC";
  result = await provider.getPage(account, targets);
  assert.equal(result.pending, false);
  assert.equal(result.submissions.at(-1).status, Status.Accepted);
  assert.equal(result.submissions.at(-1).taskId, "abc480_a");
  assert.equal(result.submissions.at(-1).time, 12);
  assert.equal(result.submissions.at(-1).memory, 1048576);
  assert.equal(result.submissions.at(-1).language, "C++23 (GCC 15.2.0)");
  await result.acknowledge();
  await provider.getPage(account, targets);
  assert.equal(calls.filter(call => !call.url.pathname.endsWith("/status/json")).length, 1);
  assert.equal(calls.filter(call => call.url.pathname.endsWith("/status/json")).length, 3);
  assert.deepEqual(JSON.parse(values.get("remote-atcoder-pages:1:abc480")).pendingRows, []);
});

test("unknown JSON IDs require verified metadata, while omitted IDs remain pending", async () => {
  const { provider, calls } = fixture(
    () => html(Array.from({ length: 23 }, (_, index) => row({ id: index + 1, verdict: "WJ" }))),
    () => statusJson(["999999"])
  );
  let result = await provider.getPage(account, targets);
  assert.equal(result.pending, true);
  assert.equal(
    result.submissions.some(row => row.id === "999999"),
    false
  );
  await result.acknowledge();
  result = await provider.getPage(account, targets);
  assert.equal(result.pending, true);
  const statusCalls = calls.filter(call => call.url.pathname.endsWith("/status/json"));
  assert.equal(statusCalls.length, 2);
  assert.ok(statusCalls.every(call => call.url.search === ""));
  assert.equal(calls.filter(call => !call.url.pathname.endsWith("/status/json")).length, 1);
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

test("a broken status API leaves list results usable, records a warning and falls back within the original site", async () => {
  const { provider, calls, values } = fixture(
    () => html([row({ id: 123, verdict: "WJ" })]),
    () => "<html>not JSON</html>"
  );
  const result = await provider.getPage(account, targets);
  assert.equal(result.pending, true);
  assert.equal(result.warning.error, "REMOTE_ATCODER_STATUS_FAILED");
  assert.equal(result.warning.details.reason, "INVALID_STATUS_RESPONSE");
  await result.acknowledge();
  assert.ok(JSON.parse(values.get("remote-atcoder-pages:1:abc480")).statusRetryAt > Date.now());
  await provider.getPage(account, targets);
  assert.equal(calls.filter(call => call.url.pathname.endsWith("/status/json")).length, 1);
  assert.ok(calls.every(call => call.url.hostname === "atcoder.jp"));
});

test("each user's requests and cooldown resolve only their own credential", async () => {
  const { provider } = fixture();
  provider.atcoderSessions = { get: async id => (id === 1 ? "private-one" : id === 2 ? "private-two" : undefined) };
  const cookies = [];
  global.fetch = async (address, options) => {
    cookies.push(options.headers.Cookie);
    return options.headers.Cookie === "REVEL_SESSION=private-one"
      ? new Response("", { status: 429 })
      : new Response(new URL(address).pathname.endsWith("/status/json") ? statusJson(["80223806"]) : html([row()]));
  };
  await assert.rejects(provider.getPage(account, targets), /REMOTE_RATE_LIMITED/);
  const second = await provider.getPage({ ...account, id: 2 }, targets);
  assert.equal(second.submissions.length, 1);
  assert.equal((await provider.getAtcoderSessionContext(2)).cooldownMs, 0);
  await assert.rejects(provider.getPage({ ...account, id: 3 }, targets), /REMOTE_AUTH_REQUIRED/);
  assert.deepEqual(cookies, ["REVEL_SESSION=private-one", "REVEL_SESSION=private-two", "REVEL_SESSION=private-two"]);
});

test("legacy pending IDs without cached metadata are still discovered beyond the previous boundary", async () => {
  const { provider, values, calls } = fixture(url =>
    html(
      Number(url.searchParams.get("page")) === 1
        ? [row({ id: 40 }), row({ id: 39 })]
        : [row({ id: 38, verdict: "AC" })],
      { more: Number(url.searchParams.get("page")) === 1 }
    )
  );
  values.set("remote-atcoder-pages:1:abc480", JSON.stringify({ page: 2, head: 0, boundary: 40, pendingIds: ["38"] }));
  const result = await provider.getPage(account, targets);
  assert.equal(result.submissions.find(row => row.id === "38").status, Status.Accepted);
  assert.equal(result.pending, false);
  assert.equal(calls.length, 3);
  await result.acknowledge();
  assert.deepEqual(JSON.parse(values.get("remote-atcoder-pages:1:abc480")).pendingIds, []);
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

test("long-running progress with a provisional TLE remains pending until the final JSON result, without more HTML", async () => {
  let finished = false;
  const { provider, values, calls } = fixture(
    () => html([row({ id: 80271618, verdict: "WJ" })]),
    () => longRunningStatus("6/26 TLE", finished)
  );
  let result = await provider.getPage(account, targets);
  assert.equal(result.submissions[0].verdict, "6/26 TLE");
  assert.equal(result.submissions[0].status, Status.Pending);
  assert.equal(result.submissions[0].time, null);
  assert.equal(result.submissions[0].memory, null);
  assert.equal(result.warning, undefined);
  assert.equal(result.pending, true);
  await result.acknowledge();
  finished = true;
  result = await provider.getPage(account, targets);
  assert.equal(result.submissions[0].status, Status.TimeLimitExceeded);
  assert.equal(result.submissions[0].verdict, "TLE");
  assert.equal(result.submissions[0].time, 2000);
  assert.equal(result.submissions[0].memory, 1616 * 1024);
  assert.equal(result.submissions[0].points, 0);
  assert.equal(result.pending, false);
  assert.equal(result.warning, undefined);
  // The new result and checkpoint are committed only after the caller imports them.
  assert.equal(JSON.parse(values.get("remote-atcoder-pages:1:abc480")).pendingRows.length, 1);
  await result.acknowledge();
  assert.equal(JSON.parse(values.get("remote-atcoder-pages:1:abc480")).pendingRows.length, 0);
  assert.equal(calls.filter(call => !call.url.pathname.endsWith("/status/json")).length, 1);
});

test("JSON discovers new IDs after a completed scan and fetches metadata only once per new submission", async () => {
  let ids = [100];
  const { provider, calls } = fixture(
    () => html(ids.map(id => row({ id, verdict: "AC" }))),
    () => statusJson(ids.map(String))
  );
  let result = await provider.getPage(account, targets);
  await result.acknowledge();
  result = await provider.getPage(account, targets);
  await result.acknowledge();
  assert.equal(calls.filter(call => !call.url.pathname.endsWith("/status/json")).length, 1);
  ids = [101, 100];
  result = await provider.getPage(account, targets);
  assert.equal(result.submissions.find(row => row.id === "101").taskId, "abc480_a");
  assert.equal(result.pending, false);
  await result.acknowledge();
  await provider.getPage(account, targets);
  assert.equal(calls.filter(call => !call.url.pathname.endsWith("/status/json")).length, 2);
  assert.equal(calls.filter(call => call.url.pathname.endsWith("/status/json")).length, 4);
});

test("an empty JSON discovery result does not repeatedly request HTML, but periodic reconciliation still runs", async () => {
  const { provider, calls, values } = fixture(() => html());
  let result = await provider.getPage(account, targets);
  await result.acknowledge();
  const saved = JSON.parse(values.get("remote-atcoder-pages:1:abc480"));
  assert.ok(saved.nextDiscoveryAt >= Date.now() + 299000);
  result = await provider.getPage(account, targets);
  await result.acknowledge();
  assert.equal(calls.filter(call => !call.url.pathname.endsWith("/status/json")).length, 1);
  saved.nextDiscoveryAt = 0;
  values.set("remote-atcoder-pages:1:abc480", JSON.stringify(saved));
  await provider.getPage(account, targets);
  assert.equal(calls.filter(call => !call.url.pathname.endsWith("/status/json")).length, 2);
});

test("more than twenty pending submissions all receive JSON updates without HTML or batch rotation", async () => {
  let verdict = "WJ";
  const ids = Array.from({ length: 23 }, (_, i) => String(i + 1));
  const { provider, calls } = fixture(
    () => html(ids.map(id => row({ id, verdict: "WJ" }))),
    () => statusJson(ids, verdict)
  );
  let result = await provider.getPage(account, targets);
  await result.acknowledge();
  verdict = "AC";
  result = await provider.getPage(account, targets);
  assert.equal(result.submissions.length, 23);
  assert.ok(result.submissions.every(row => row.status === Status.Accepted));
  assert.equal(result.pending, false);
  assert.equal(calls.filter(call => !call.url.pathname.endsWith("/status/json")).length, 1);
});

test("metadata absent from a lagging list stays unresolved and retries are throttled", async () => {
  let listed = false;
  const { provider, calls, values } = fixture(
    () => html(listed ? [row({ id: 321, verdict: "AC" })] : []),
    () => statusJson(["321"])
  );
  let result = await provider.getPage(account, targets);
  assert.deepEqual(result.submissions, []);
  assert.equal(result.pending, true);
  await result.acknowledge();
  result = await provider.getPage(account, targets);
  assert.deepEqual(result.submissions, []);
  await result.acknowledge();
  assert.equal(calls.filter(call => !call.url.pathname.endsWith("/status/json")).length, 1);
  const saved = JSON.parse(values.get("remote-atcoder-pages:1:abc480"));
  saved.metadataRetryAt = 0;
  values.set("remote-atcoder-pages:1:abc480", JSON.stringify(saved));
  listed = true;
  result = await provider.getPage(account, targets);
  assert.equal(result.submissions[0].id, "321");
  assert.equal(result.pending, false);
});

test("a later final HTML result takes precedence over an earlier pending JSON snapshot", async () => {
  const { provider } = fixture(
    () => html([row({ id: 321, verdict: "AC" })]),
    () => statusJson(["321"], "WJ")
  );
  const result = await provider.getPage(account, targets);
  assert.equal(result.submissions[0].status, Status.Accepted);
  assert.equal(result.pending, false);
});

test("bounded metadata cache does not rediscover older JSON IDs on every turn", async () => {
  const ids = Array.from({ length: 205 }, (_, i) => String(i + 1));
  const { provider, values, calls } = fixture(
    () => html(ids.map(id => row({ id, verdict: "AC" }))),
    () => statusJson(ids)
  );
  const result = await provider.getPage(account, targets);
  await result.acknowledge();
  assert.equal(JSON.parse(values.get("remote-atcoder-pages:1:abc480")).knownRows.length, 200);
  const next = await provider.getPage(account, targets);
  assert.equal(next.pending, false);
  assert.equal(calls.filter(call => !call.url.pathname.endsWith("/status/json")).length, 1);
});

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
