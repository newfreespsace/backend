#!/usr/bin/env node
// Read-only probe: no Nest bootstrap, schema synchronization, Redis connection or database writes.
const fs = require("node:fs");
const path = require("node:path");

// Diagnostic profile copied from the browser request supplied during investigation.
const browserUserAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";

const safeCodes = new Set([
  "INVALID_SUBMISSION_URL",
  "REMOTE_AUTH_REQUIRED",
  "REMOTE_SESSION_UNREADABLE",
  "REMOTE_RESPONSE_TOO_LARGE",
  "CONFIG_READ_FAILED",
  "CONFIG_PARSE_FAILED",
  "CONFIG_INVALID",
  "DEPENDENCY_LOAD_FAILED",
  "BACKEND_BUILD_MISSING",
  "BACKEND_MODULE_LOAD_FAILED",
  "DATABASE_CONNECT_FAILED",
  "SESSION_QUERY_FAILED",
  "SESSION_DATA_INVALID"
]);
const safeDetails = new Set([
  "ENOENT",
  "EACCES",
  "EPERM",
  "MODULE_NOT_FOUND",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ER_ACCESS_DENIED_ERROR",
  "ER_DBACCESS_DENIED_ERROR",
  "ER_BAD_DB_ERROR",
  "ER_NO_SUCH_TABLE",
  "ER_BAD_FIELD_ERROR",
  "ER_TABLEACCESS_DENIED_ERROR",
  "ER_PARSE_ERROR",
  "ER_CON_COUNT_ERROR",
  "ER_TOO_MANY_USER_CONNECTIONS",
  "ER_NOT_SUPPORTED_AUTH_MODE",
  "HANDSHAKE_SSL_ERROR"
]);

async function readStep(code, action) {
  try {
    return await action();
  } catch (error) {
    if (safeCodes.has(error?.message)) throw error;
    const failure = new Error(code);
    if (safeDetails.has(error?.code)) failure.detail = error.code;
    throw failure;
  }
}

function formatFailure(stage, error) {
  const code = safeCodes.has(error?.message) ? error.message : "CHECK_FAILED";
  const detail = safeDetails.has(error?.detail) ? ` (${error.detail})` : "";
  return `${stage}失败：${code}${detail}`;
}

function submissionUrl(input) {
  const url = new URL(input);
  if (
    url.origin !== "https://atcoder.jp" ||
    url.username ||
    url.password ||
    !/^\/contests\/[\w-]+\/submissions\/\d+$/.test(url.pathname)
  )
    throw new Error("INVALID_SUBMISSION_URL");
  url.search = "?lang=en";
  url.hash = "";
  return url;
}

async function loadSession(configPath) {
  const yaml = await readStep("DEPENDENCY_LOAD_FAILED", () => require("js-yaml"));
  const text = await readStep("CONFIG_READ_FAILED", () => fs.readFileSync(configPath, "utf8"));
  const config = await readStep("CONFIG_PARSE_FAILED", () => yaml.load(text));
  const db = config?.services?.database;
  if (
    !db ||
    !["mysql", "mariadb"].includes(db.type) ||
    ![db.host, db.username, db.password, db.database, config?.security?.sessionSecret].every(
      value => typeof value === "string"
    ) ||
    !Number.isInteger(Number(db.port)) ||
    Number(db.port) < 1 ||
    Number(db.port) > 65535
  )
    throw new Error("CONFIG_INVALID");
  const mysql = await readStep("DEPENDENCY_LOAD_FAILED", () => require("mysql2/promise"));
  const compiledService = path.resolve(__dirname, "../dist/site-setting/site-setting.service.js");
  if (!fs.existsSync(compiledService)) throw new Error("BACKEND_BUILD_MISSING");
  const { SiteSettingService } = await readStep("BACKEND_MODULE_LOAD_FAILED", () => {
    require("reflect-metadata");
    return require(compiledService);
  });
  const connection = await readStep("DATABASE_CONNECT_FAILED", () =>
    mysql.createConnection({
      host: db.host,
      port: Number(db.port),
      user: db.username,
      password: db.password,
      database: db.database,
      connectTimeout: 10000
    })
  );
  try {
    const [rows] = await readStep("SESSION_QUERY_FAILED", () =>
      connection.execute("SELECT `value` FROM `site_setting` WHERE `key` = ? LIMIT 1", ["remote-judge:atcoder-session"])
    );
    const setting = rows[0];
    if (typeof setting?.value === "string")
      setting.value = await readStep("SESSION_DATA_INVALID", () => JSON.parse(setting.value));
    const service = new SiteSettingService({ findOneBy: async () => setting || null }, { config });
    const session = await readStep("SESSION_DATA_INVALID", () => service.getAtcoderSession());
    if (!session || /[;\s]/.test(session)) throw new Error("REMOTE_AUTH_REQUIRED");
    return session;
  } finally {
    try {
      await connection.end();
    } catch {
      try {
        connection.destroy();
      } catch {
        // Preserve the read/decryption error if connection cleanup also fails.
      }
    }
  }
}

function hasAtcoderLink($, selector, attribute, pathname) {
  return $(selector)
    .toArray()
    .some(element => {
      try {
        const target = new URL($(element).attr(attribute), "https://atcoder.jp");
        return target.origin === "https://atcoder.jp" && target.pathname === pathname;
      } catch {
        return false;
      }
    });
}

async function probePage(url, session, fetchPage, diagnostics = false, expectSource = true, requestHeaders = {}) {
  const response = await fetchPage(url.toString(), {
    redirect: "manual",
    signal: AbortSignal.timeout(20000),
    headers: {
      "User-Agent": browserUserAgent,
      Accept: "text/html",
      ...requestHeaders,
      ...(session ? { Cookie: `REVEL_SESSION=${session}` } : {})
    }
  });
  const result = { httpStatus: response.status, sourceReadable: false };
  if (response.status >= 300 && response.status < 400) {
    const location = new URL(response.headers.get("location") || "/", url);
    result.reason = location.origin === url.origin && location.pathname === "/login" ? "LOGIN_REQUIRED" : "REDIRECT";
  } else if (response.status === 403) result.reason = "ACCESS_DENIED";
  else if (response.status === 429) result.reason = "RATE_LIMITED";
  else if (response.status !== 200) result.reason = "HTTP_ERROR";
  else result.reason = "SOURCE_NOT_FOUND";
  if (response.status === 200 || diagnostics) {
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 8 * 1024 * 1024) throw new Error("REMOTE_RESPONSE_TOO_LARGE");
      chunks.push(chunk);
    }
    const $ = require("cheerio").load(Buffer.concat(chunks).toString("utf8"));
    const source = $("#submission-code");
    if (expectSource && response.status === 200 && source.length && source.text().trim()) {
      result.sourceReadable = true;
      result.sourceCharacters = source.text().length;
      result.reason = "SOURCE_FOUND";
    } else if (response.status === 200) {
      result.reason =
        hasAtcoderLink($, "form[action]", "action", "/login") || $('input[name="password"]').length
          ? "LOGIN_REQUIRED"
          : expectSource
          ? "SOURCE_NOT_FOUND"
          : "PAGE_ACCESSIBLE";
    }
    if (diagnostics) {
      const server = response.headers.get("server") || "";
      const via = response.headers.get("via") || "";
      result.edge = /cloudfront/i.test(server + via)
        ? "CloudFront"
        : /cloudflare/i.test(server) || response.headers.has("cf-ray")
        ? "Cloudflare"
        : "Other";
      result.cloudFrontErrorPage = /the request could not be satisfied|generated by cloudfront/i.test($.text());
      result.loggedInMarkerFound =
        hasAtcoderLink($, "form[action]", "action", "/logout") || hasAtcoderLink($, "a[href]", "href", "/logout");
      result.submissionListFound = $("table")
        .toArray()
        .some(table => {
          const headers = $(table)
            .find("thead th")
            .map((_, cell) => $(cell).text().trim())
            .get();
          return ["Submission Time", "Task", "User", "Language", "Score", "Status"].every(header =>
            headers.includes(header)
          );
        });
    }
  }
  if (!response.bodyUsed) await response.body?.cancel();
  return result;
}

async function checkSource(input, session, fetchPage = global.fetch) {
  const url = submissionUrl(input);
  if (!session || /[;\s]/.test(session)) throw new Error("REMOTE_AUTH_REQUIRED");
  return await probePage(url, session, fetchPage);
}

async function diagnoseSource(
  input,
  session,
  fetchPage = global.fetch,
  pause = ms => new Promise(resolve => setTimeout(resolve, ms))
) {
  const detail = submissionUrl(input);
  if (!session || /[;\s]/.test(session)) throw new Error("REMOTE_AUTH_REQUIRED");
  const contest = detail.pathname.split("/")[2];
  const pages = [
    ["public_home", new URL("https://atcoder.jp/?lang=en"), undefined],
    ["account_settings", new URL("https://atcoder.jp/settings?lang=en"), session],
    ["own_submission_list", new URL(`https://atcoder.jp/contests/${contest}/submissions/me?lang=en`), session],
    ["submission_detail", detail, session]
  ];
  const checks = [];
  for (const [page, url, cookie] of pages) {
    if (checks.length) await pause(1600);
    try {
      checks.push({ page, ...(await probePage(url, cookie, fetchPage, true, page === "submission_detail")) });
    } catch (error) {
      checks.push({
        page,
        sourceReadable: false,
        reason: error.message === "REMOTE_RESPONSE_TOO_LARGE" ? error.message : "NETWORK_ERROR"
      });
    }
  }
  return { sourceReadable: checks.some(check => check.page === "submission_detail" && check.sourceReadable), checks };
}

async function compareRequests(
  input,
  session,
  fetchPage = global.fetch,
  pause = ms => new Promise(resolve => setTimeout(resolve, ms))
) {
  const detail = submissionUrl(input);
  if (!session || /[;\s]/.test(session)) throw new Error("REMOTE_AUTH_REQUIRED");
  const plain = new URL(detail);
  plain.search = "";
  const contest = plain.pathname.split("/")[2];
  // Same saved session and submission in every request. No browser Cookie is imported.
  const profiles = [
    ["default_with_lang", detail, { "User-Agent": "NSOJ-Result-Sync/1.0" }],
    ["default_without_lang", plain, { "User-Agent": "NSOJ-Result-Sync/1.0" }],
    ["browser_user_agent", plain, { "User-Agent": browserUserAgent }],
    [
      "browser_headers",
      plain,
      {
        "User-Agent": browserUserAgent,
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/jxl,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        Priority: "u=0, i",
        Referer: `https://atcoder.jp/contests/${contest}/submissions`,
        "Sec-CH-UA": '"Google Chrome";v="155", "Chromium";v="155", "Not(A:Brand";v="24"',
        "Sec-CH-UA-Mobile": "?0",
        "Sec-CH-UA-Platform": '"macOS"',
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "same-origin",
        "Sec-Fetch-User": "?1",
        "Upgrade-Insecure-Requests": "1"
      }
    ]
  ];
  const checks = [];
  for (const [profile, url, headers] of profiles) {
    if (checks.length) await pause(1600);
    try {
      const result = await probePage(url, session, fetchPage, true, true, headers);
      checks.push({ profile, ...result });
      if (result.reason === "RATE_LIMITED") break;
    } catch (error) {
      checks.push({
        profile,
        sourceReadable: false,
        reason: error.message === "REMOTE_RESPONSE_TOO_LARGE" ? error.message : "NETWORK_ERROR"
      });
    }
  }
  return { sourceReadable: checks.some(check => check.sourceReadable), checks };
}

async function main() {
  const args = process.argv.slice(2);
  const [input, configArg] = args.filter(arg => !["--diagnose", "--compare-requests"].includes(arg));
  if (!input || input === "--help") {
    console.log("用法：node scripts/check-atcoder-source.cjs <AtCoder 提交详情链接> [后端 config.yaml 路径]");
    console.log("附加 --diagnose：依次对比公共首页、账号设置、自己的提交列表和提交详情。");
    console.log("附加 --compare-requests：用同一已保存会话对比查询参数、User-Agent 和浏览器请求头，最多四次请求。");
    console.log("使用站点已保存的会话，只输出检查结果；不打印 Cookie 或源码，也不修改数据。");
    if (!input) process.exitCode = 2;
    return;
  }
  let stage = "校验提交链接";
  try {
    const url = submissionUrl(input);
    stage = "读取配置和已保存的会话";
    const session = await loadSession(configArg || process.env.LYRIO_CONFIG_FILE || path.resolve("config.yaml"));
    stage = "请求 AtCoder 提交详情";
    const result = args.includes("--compare-requests")
      ? await compareRequests(url.toString(), session)
      : args.includes("--diagnose")
      ? await diagnoseSource(url.toString(), session)
      : await checkSource(url.toString(), session);
    console.log(JSON.stringify(result, null, 2));
    if (!result.sourceReadable) process.exitCode = 2;
  } catch (error) {
    // Raw errors can contain a cookie, SQL values or config contents. Print fixed codes only.
    console.error(formatFailure(stage, error));
    process.exitCode = 1;
  }
}

module.exports = { submissionUrl, checkSource, diagnoseSource, compareRequests, loadSession, formatFailure };
if (require.main === module) void main();
