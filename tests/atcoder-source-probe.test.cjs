const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { createCipheriv, createHmac } = require("node:crypto");
const {
  submissionUrl,
  checkSource,
  diagnoseSource,
  loadSession,
  formatFailure
} = require("../scripts/check-atcoder-source.cjs");
const url = "https://atcoder.jp/contests/abc480/submissions/12345678";

test("probe sends the configured session only to an original-site submission and never follows redirects", async () => {
  const code = "// private code\nint main() { return 1 < 2; }\n";
  const result = await checkSource(url, "test-session", async (address, options) => {
    assert.equal(address, url + "?lang=en");
    assert.equal(options.headers.Cookie, "REVEL_SESSION=test-session");
    assert.equal(options.redirect, "manual");
    return new Response('<pre id="submission-code">// private code\nint main() { return 1 &lt; 2; }\n</pre>');
  });
  assert.deepEqual(result, {
    httpStatus: 200,
    sourceReadable: true,
    sourceCharacters: code.length,
    reason: "SOURCE_FOUND"
  });
  assert.doesNotMatch(JSON.stringify(result), /test-session|private code|int main/);
});

test("probe distinguishes login, access denial, rate limits and absent source without exposing response bodies", async () => {
  for (const [status, body, headers, reason] of [
    [302, "", { location: "/login?private=test-session" }, "LOGIN_REQUIRED"],
    [302, "", { location: "https://other.example/login" }, "REDIRECT"],
    [403, "private-response", {}, "ACCESS_DENIED"],
    [429, "private-response", {}, "RATE_LIMITED"],
    [503, "private-response", {}, "HTTP_ERROR"],
    [200, '<form action="/login"><input name="password"></form>', {}, "LOGIN_REQUIRED"],
    [200, '<pre id="submission-code">  </pre>', {}, "SOURCE_NOT_FOUND"],
    [200, "<html>private-response</html>", {}, "SOURCE_NOT_FOUND"]
  ]) {
    const result = await checkSource(url, "test-session", async () => new Response(body, { status, headers }));
    assert.deepEqual(result, { httpStatus: status, sourceReadable: false, reason });
    assert.doesNotMatch(JSON.stringify(result), /test-session|private-response|other.example/);
  }
});

test("probe rejects foreign hosts, non-submission URLs and invalid cookies before any request", async () => {
  let fetches = 0;
  const fetchPage = async () => fetches++;
  for (const invalid of [
    "http://atcoder.jp/contests/abc480/submissions/123",
    "https://atcoder.jp.evil.example/contests/abc480/submissions/123",
    "https://atcoder.jp:8443/contests/abc480/submissions/123",
    "https://user:secret@atcoder.jp/contests/abc480/submissions/123",
    "https://atcoder.jp/login",
    "https://atcoder.jp/contests/abc480/submissions/../../login"
  ]) {
    await assert.rejects(checkSource(invalid, "test-session", fetchPage), /INVALID_SUBMISSION_URL/);
  }
  for (const session of [undefined, "", "bad; other=value", "bad\r\nHeader: injected"])
    await assert.rejects(checkSource(url, session, fetchPage), /REMOTE_AUTH_REQUIRED/);
  assert.equal(fetches, 0);
  assert.equal(submissionUrl(url + "?token=private#fragment").toString(), url + "?lang=en");
});

test("probe rejects oversized responses", async () => {
  await assert.rejects(
    checkSource(url, "test-session", async () => new Response("x".repeat(8 * 1024 * 1024 + 1))),
    /REMOTE_RESPONSE_TOO_LARGE/
  );
});

test("CLI help and invalid URL checks need no database or session and do not print input secrets", () => {
  const script = path.resolve(__dirname, "../scripts/check-atcoder-source.cjs");
  const help = spawnSync(process.execPath, [script, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /用法/);
  const invalid = spawnSync(process.execPath, [script, "https://private-user:private-password@other.example/"], {
    encoding: "utf8"
  });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /INVALID_SUBMISSION_URL/);
  assert.doesNotMatch(invalid.stderr + invalid.stdout, /private-user|private-password|other.example/);
});

test("diagnostics separate an authenticated accessible list from a blocked detail without leaking source or headers", async () => {
  const requests = [],
    pauses = [];
  const result = await diagnoseSource(
    url,
    "test-session",
    async (address, options) => {
      requests.push(address);
      assert.equal(options.redirect, "manual");
      assert.equal(options.headers.Cookie, requests.length === 1 ? undefined : "REVEL_SESSION=test-session");
      const pathname = new URL(address).pathname;
      if (pathname === "/settings") return new Response('<form action="/logout">private account data</form>');
      if (pathname.endsWith("/submissions/me"))
        return new Response(
          `<table><thead><tr>${["Submission Time", "Task", "User", "Language", "Score", "Status"]
            .map(header => `<th>${header}</th>`)
            .join("")}</tr></thead><tbody></tbody></table>`
        );
      if (pathname.endsWith("/12345678"))
        return new Response("The request could not be satisfied. Generated by cloudfront. private-response", {
          status: 403,
          headers: { server: "CloudFront", "x-private": "test-session" }
        });
      return new Response("<html>Public page</html>");
    },
    async ms => pauses.push(ms)
  );
  assert.deepEqual(
    requests.map(address => new URL(address).pathname),
    ["/", "/settings", "/contests/abc480/submissions/me", "/contests/abc480/submissions/12345678"]
  );
  assert.deepEqual(pauses, [1600, 1600, 1600]);
  assert.equal(result.sourceReadable, false);
  assert.equal(result.checks[1].loggedInMarkerFound, true);
  assert.equal(result.checks[2].submissionListFound, true);
  assert.equal(result.checks[3].reason, "ACCESS_DENIED");
  assert.equal(result.checks[3].edge, "CloudFront");
  assert.equal(result.checks[3].cloudFrontErrorPage, true);
  assert.doesNotMatch(JSON.stringify(result), /test-session|private account|private-response|x-private/);
});

test("diagnostics distinguish login redirects and continue after per-page network errors", async () => {
  const result = await diagnoseSource(
    url,
    "test-session",
    async address => {
      const pathname = new URL(address).pathname;
      if (pathname === "/settings")
        return new Response("", { status: 302, headers: { location: "/login?token=test-session" } });
      if (pathname.endsWith("/submissions/me")) throw new Error("test-session private-network-error");
      if (pathname.endsWith("/12345678")) return new Response('<pre id="submission-code">private-code</pre>');
      return new Response("Public");
    },
    async () => {}
  );
  assert.equal(result.checks[1].reason, "LOGIN_REQUIRED");
  assert.equal(result.checks[2].reason, "NETWORK_ERROR");
  assert.equal(result.checks[3].reason, "SOURCE_FOUND");
  assert.equal(result.sourceReadable, true);
  assert.doesNotMatch(JSON.stringify(result), /test-session|private-network-error|private-code/);
});

test("diagnostics validate the URL and session before even the public control request", async () => {
  let fetches = 0;
  const fetchPage = async () => fetches++;
  await assert.rejects(diagnoseSource("https://other.example/", "test-session", fetchPage), /INVALID_SUBMISSION_URL/);
  await assert.rejects(diagnoseSource(url, undefined, fetchPage), /REMOTE_AUTH_REQUIRED/);
  assert.equal(fetches, 0);
});

function configFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nsoj-atcoder-config-test-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "config.yaml");
  const config = {
    services: {
      database: {
        type: "mariadb",
        host: "127.0.0.1",
        port: 3306,
        username: "test",
        password: "private-db-password",
        database: "test"
      }
    },
    security: { sessionSecret: "private-encryption-key" }
  };
  fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  return { file, config };
}

test("session loading reads the saved encrypted session through the actual compiled service without application startup", async t => {
  const { file, config } = configFixture(t);
  const mysql = require("mysql2/promise");
  const key = createHmac("sha256", config.security.sessionSecret).update("NSOJ:AtCoder:session:v1").digest();
  const iv = Buffer.alloc(12, 1);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from("remote-judge:atcoder-session"));
  const value = {
    version: 1,
    iv: iv.toString("base64"),
    ciphertext: Buffer.concat([cipher.update("private-test-session", "utf8"), cipher.final()]).toString("base64"),
    tag: cipher.getAuthTag().toString("base64")
  };
  let stringify = false,
    closed = 0;
  t.mock.method(mysql, "createConnection", async options => {
    assert.equal(options.password, "private-db-password");
    return {
      execute: async (sql, parameters) => {
        assert.equal(sql, "SELECT `value` FROM `site_setting` WHERE `key` = ? LIMIT 1");
        assert.deepEqual(parameters, ["remote-judge:atcoder-session"]);
        return [[{ value: stringify ? JSON.stringify(value) : value }]];
      },
      end: async () => closed++
    };
  });
  assert.equal(await loadSession(file), "private-test-session");
  stringify = true;
  assert.equal(await loadSession(file), "private-test-session");
  assert.equal(closed, 2);
});

test("configuration errors identify file reads, invalid YAML and invalid shapes without exposing contents", async t => {
  const { file } = configFixture(t);
  await assert.rejects(loadSession(file + ".missing"), error => {
    assert.equal(error.message, "CONFIG_READ_FAILED");
    assert.equal(error.detail, "ENOENT");
    return true;
  });
  fs.writeFileSync(file, 'private-session: "unterminated');
  await assert.rejects(loadSession(file), /CONFIG_PARSE_FAILED/);
  fs.writeFileSync(file, "private-session: secret-value");
  await assert.rejects(loadSession(file), /CONFIG_INVALID/);
});

test("database authentication and query failures retain safe codes, close connections and omit raw errors", async t => {
  const { file } = configFixture(t);
  const mysql = require("mysql2/promise");
  const databaseError = Object.assign(new Error("private-db-password private-test-session"), {
    code: "ER_ACCESS_DENIED_ERROR"
  });
  const connect = t.mock.method(mysql, "createConnection", async () => {
    throw databaseError;
  });
  await assert.rejects(loadSession(file), error => {
    assert.equal(error.message, "DATABASE_CONNECT_FAILED");
    assert.equal(error.detail, "ER_ACCESS_DENIED_ERROR");
    assert.doesNotMatch(formatFailure("读取配置", error), /private-db-password|private-test-session/);
    return true;
  });
  let closed = false;
  connect.mock.mockImplementation(async () => ({
    execute: async () => {
      throw Object.assign(new Error("private-sql-values"), { code: "ER_NO_SUCH_TABLE" });
    },
    end: async () => {
      closed = true;
    }
  }));
  await assert.rejects(loadSession(file), error => {
    assert.equal(error.message, "SESSION_QUERY_FAILED");
    assert.equal(error.detail, "ER_NO_SUCH_TABLE");
    return true;
  });
  assert.equal(closed, true);
});

test("unreadable stored JSON, corrupted encrypted sessions and disabled sessions have distinct errors", async t => {
  const { file } = configFixture(t);
  const mysql = require("mysql2/promise");
  let value = "private-invalid-json";
  let closed = 0;
  t.mock.method(mysql, "createConnection", async () => ({
    execute: async () => [[{ value }]],
    end: async () => closed++
  }));
  await assert.rejects(loadSession(file), /SESSION_DATA_INVALID/);
  value = { version: 1, ciphertext: "corrupted" };
  await assert.rejects(loadSession(file), /REMOTE_SESSION_UNREADABLE/);
  value = { version: 1, disabled: true };
  await assert.rejects(loadSession(file), /REMOTE_AUTH_REQUIRED/);
  assert.equal(closed, 3);
});

test("CLI exposes a missing config file code and safe errno without printing arbitrary errors", () => {
  const script = path.resolve(__dirname, "../scripts/check-atcoder-source.cjs");
  const missing = spawnSync(process.execPath, [script, url, path.join(__dirname, "private-missing-config.yaml")], {
    encoding: "utf8"
  });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /CONFIG_READ_FAILED \(ENOENT\)/);
  assert.doesNotMatch(missing.stderr, /private-missing-config/);
  assert.equal(
    formatFailure("检查", Object.assign(new Error("private-session-value"), { detail: "private-db-password" })),
    "检查失败：CHECK_FAILED"
  );
});
