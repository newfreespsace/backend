import * as cheerio from "cheerio";
import moment from "moment-timezone";

import { RemoteSubmission, remoteVerdict, SubmissionMethod } from "./remote-judge.types";
import { RemoteSyncError } from "./remote-error";
import { assertAtcoderPage } from "./atcoder-request";

function numericValue(text: string): number | null {
  const value = text.replace(/,/g, "").trim();
  return /^-?\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value)) ? Number(value) : null;
}

function resourceValue(text: string, units: Record<string, number>): number | null {
  const match = text.trim().match(/^(?:>\s*)?([\d,.]+)\s*(\w+)$/);
  if (!match || !units[match[2]]) return null;
  const value = numericValue(match[1]);
  return value == null ? null : value * units[match[2]];
}

/** Parse the English, server-rendered submission list, before AtCoder's local-time script runs. */
export function parseAtcoderSubmissionPage(html: string, contestId: string, handle: string, page: number) {
  const $ = cheerio.load(html);
  try {
    assertAtcoderPage($);
  } catch (error) {
    error.details = { ...error.details, contestId, page };
    throw error;
  }
  const fail = (reason: string, submissionId?: string): never => {
    throw new RemoteSyncError("REMOTE_PARSE_FAILED", {
      stage: "parse",
      reason,
      contestId,
      page,
      submissionId
    });
  };
  const table = $("table")
    .toArray()
    .find(element => {
      const headers = $(element)
        .find("thead th")
        .map((_, cell) => $(cell).text().trim())
        .get();
      return ["Submission Time", "Task", "User", "Language", "Score", "Status"].every(name => headers.includes(name));
    });
  if (!table) {
    // An empty search may omit the table entirely. Require the authenticated contest search
    // and an explicit empty-result message; missing markup alone is never a successful sync.
    const path = `/contests/${contestId}/submissions`;
    const search = $("form")
      .toArray()
      .some(form => {
        try {
          const action = $(form).attr("action");
          const target = new URL(action || path, `https://atcoder.jp${path}`);
          return (
            target.origin === "https://atcoder.jp" &&
            target.pathname === path &&
            (!$(form).attr("method") || $(form).attr("method").toLowerCase() === "get") &&
            $(form).find('[name="f.User"]').val()?.toString().toLowerCase() === handle.toLowerCase() &&
            $(form).find('[name="f.Task"], [name="f.Status"]').length > 0
          );
        } catch {
          return false;
        }
      });
    const loggedIn = $("a[href], form[action]")
      .toArray()
      .some(element => {
        try {
          const target = new URL($(element).attr("href") || $(element).attr("action"), "https://atcoder.jp");
          return target.origin === "https://atcoder.jp" && target.pathname === "/logout";
        } catch {
          return false;
        }
      });
    const empty = $("#main-container p, #main-container .alert, #main-container .text-center")
      .toArray()
      .some(element =>
        /^(?:(?:There (?:is|are) no|No) submissions?(?: found)?[.!]?|提出(?:が|は)ありません[。.]?)$/i.test(
          $(element).text().trim()
        )
      );
    if (!$("table").length && search && loggedIn && empty) return { submissions: [], more: false };
    fail($("table").length ? "UNEXPECTED_TABLE_HEADERS" : "MISSING_SUBMISSION_TABLE");
  }
  const headers = $(table)
    .find("thead th")
    .map((_, cell) => $(cell).text().trim())
    .get();
  const submissions: RemoteSubmission[] = [];
  for (const row of $(table).find("tbody tr").toArray()) {
    const cells = $(row).children("td");
    const cell = (name: string) => cells.eq(headers.indexOf(name));
    const userLink = cell("User").find('a[href^="/users/"]').first();
    if (userLink.attr("href")?.toLowerCase() !== `/users/${handle.toLowerCase()}`) continue;
    const task = cell("Task")
      .find("a")
      .attr("href")
      ?.match(/^\/contests\/([\w-]+)\/tasks\/([\w-]+)$/);
    const detail = $(row)
      .find("a.submission-details-link")
      .attr("href")
      ?.match(/^\/contests\/([\w-]+)\/submissions\/(\d+)$/);
    const time = cell("Submission Time").find("time");
    const rawTime = (time.attr("datetime") || time.text()).trim();
    const submitted = /(?:Z|[+-]\d{2}:?\d{2})$/.test(rawTime)
      ? moment.parseZone(rawTime, ["YYYY-MM-DD HH:mm:ssZZ", moment.ISO_8601], true)
      : moment.tz(rawTime, "YYYY-MM-DD HH:mm:ss", true, "Asia/Tokyo");
    const verdict = cell("Status")
      .text()
      .trim()
      .replace(/\s*\/\s*/g, "/");
    const language = cell("Language").text().trim();
    if (!task || task[1] !== contestId) fail("INVALID_TASK_LINK", detail?.[2]);
    if (!detail || detail[1] !== contestId) fail("INVALID_SUBMISSION_LINK");
    if (!Number.isSafeInteger(Number(detail[2])) || Number(detail[2]) <= 0) fail("INVALID_SUBMISSION_ID");
    if (!submitted.isValid()) fail("INVALID_SUBMISSION_TIME", detail[2]);
    if (!verdict) fail("MISSING_VERDICT", detail[2]);
    if (!language) fail("MISSING_LANGUAGE", detail[2]);
    submissions.push({
      id: detail[2],
      contestId,
      taskId: task[2],
      submittedAt: submitted.unix(),
      verdict,
      status: remoteVerdict(SubmissionMethod.AtCoder, verdict),
      language,
      time: resourceValue(cell("Exec Time").text(), { ms: 1, s: 1000 }),
      memory: resourceValue(cell("Memory").text(), { B: 1, KiB: 1024, MiB: 1024 * 1024, KB: 1024 }),
      points: numericValue(cell("Score").text()) ?? undefined,
      resultSource: "OriginalSite",
      url: `https://atcoder.jp/contests/${contestId}/submissions/${detail[2]}`
    });
  }
  const more = $(".pagination a")
    .toArray()
    .some(link => {
      try {
        const url = new URL($(link).attr("href"), "https://atcoder.jp");
        return (
          url.origin === "https://atcoder.jp" &&
          url.pathname === `/contests/${contestId}/submissions` &&
          Number(url.searchParams.get("page")) > page
        );
      } catch {
        return false;
      }
    });
  return { submissions, more };
}
