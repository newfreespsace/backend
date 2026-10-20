import * as cheerio from "cheerio";
import moment from "moment-timezone";

import { RemoteSubmission, remoteVerdict, SubmissionMethod } from "./remote-judge.types";

function numericValue(text: string): number | null {
  const value = text.replace(/,/g, "").trim();
  return /^-?\d+(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value)) ? Number(value) : null;
}

function resourceValue(text: string, units: Record<string, number>): number | null {
  const match = text.trim().match(/^([\d,.]+)\s*(\w+)$/);
  if (!match || !units[match[2]]) return null;
  const value = numericValue(match[1]);
  return value == null ? null : value * units[match[2]];
}

/** Parse the English, server-rendered submission list, before AtCoder's local-time script runs. */
export function parseAtcoderSubmissionPage(html: string, contestId: string, handle: string, page: number) {
  const $ = cheerio.load(html);
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
    if ($('form[action="/login"], input[name="password"]').length) throw new Error("REMOTE_AUTH_REQUIRED");
    throw new Error("REMOTE_PARSE_FAILED");
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
    if (
      !task ||
      task[1] !== contestId ||
      !detail ||
      detail[1] !== contestId ||
      !Number.isSafeInteger(Number(detail[2])) ||
      Number(detail[2]) <= 0 ||
      !submitted.isValid() ||
      !verdict ||
      !language
    )
      throw new Error("REMOTE_PARSE_FAILED");
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
