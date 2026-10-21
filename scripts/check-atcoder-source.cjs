#!/usr/bin/env node
// Read-only probe: no Nest bootstrap, schema synchronization, Redis connection or database writes.
const fs = require("node:fs");
const path = require("node:path");

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
  const yaml = require("js-yaml");
  const mysql = require("mysql2/promise");
  const config = yaml.load(fs.readFileSync(configPath, "utf8"));
  require("reflect-metadata");
  const { SiteSettingService } = require("../dist/site-setting/site-setting.service");
  const db = config.services.database;
  const connection = await mysql.createConnection({
    host: db.host,
    port: Number(db.port),
    user: db.username,
    password: db.password,
    database: db.database,
    connectTimeout: 10000
  });
  try {
    const [rows] = await connection.execute("SELECT value FROM site_setting WHERE `key` = ? LIMIT 1", [
      "remote-judge:atcoder-session"
    ]);
    const setting = rows[0];
    if (typeof setting?.value === "string") setting.value = JSON.parse(setting.value);
    const service = new SiteSettingService({ findOneBy: async () => setting || null }, { config });
    return await service.getAtcoderSession();
  } finally {
    await connection.end();
  }
}

async function checkSource(input, session, fetchPage = global.fetch) {
  const url = submissionUrl(input);
  if (!session || /[;\s]/.test(session)) throw new Error("REMOTE_AUTH_REQUIRED");
  const response = await fetchPage(url.toString(), {
    redirect: "manual",
    signal: AbortSignal.timeout(20000),
    headers: {
      "User-Agent": "NSOJ-Result-Sync/1.0",
      Accept: "text/html",
      Cookie: `REVEL_SESSION=${session}`
    }
  });
  const result = { httpStatus: response.status, sourceReadable: false };
  if (response.status >= 300 && response.status < 400) {
    const location = new URL(response.headers.get("location") || "/", url);
    result.reason = location.origin === url.origin && location.pathname === "/login" ? "LOGIN_REQUIRED" : "REDIRECT";
  } else if (response.status === 403) result.reason = "ACCESS_DENIED";
  else if (response.status === 429) result.reason = "RATE_LIMITED";
  else if (response.status !== 200) result.reason = "HTTP_ERROR";
  else {
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > 8 * 1024 * 1024) throw new Error("REMOTE_RESPONSE_TOO_LARGE");
      chunks.push(chunk);
    }
    const $ = require("cheerio").load(Buffer.concat(chunks).toString("utf8"));
    const source = $("#submission-code");
    if (source.length && source.text().trim()) {
      result.sourceReadable = true;
      result.sourceCharacters = source.text().length;
      result.reason = "SOURCE_FOUND";
    } else {
      result.reason = $('form[action="/login"], input[name="password"]').length ? "LOGIN_REQUIRED" : "SOURCE_NOT_FOUND";
    }
  }
  if (!response.bodyUsed) await response.body?.cancel();
  return result;
}

async function main() {
  const [input, configArg] = process.argv.slice(2);
  if (!input || input === "--help") {
    console.log("用法：node scripts/check-atcoder-source.cjs <AtCoder 提交详情链接> [后端 config.yaml 路径]");
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
    const result = await checkSource(url.toString(), session);
    console.log(JSON.stringify(result, null, 2));
    if (!result.sourceReadable) process.exitCode = 2;
  } catch (error) {
    // Raw errors can contain a cookie, SQL values or config contents. Print fixed codes only.
    const safeCode = [
      "INVALID_SUBMISSION_URL",
      "REMOTE_AUTH_REQUIRED",
      "REMOTE_SESSION_UNREADABLE",
      "REMOTE_RESPONSE_TOO_LARGE"
    ].includes(error.message)
      ? error.message
      : "CHECK_FAILED";
    console.error(`${stage}失败：${safeCode}`);
    process.exitCode = 1;
  }
}

module.exports = { submissionUrl, checkSource };
if (require.main === module) void main();
