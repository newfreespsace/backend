import * as cheerio from "cheerio";
import moment from "moment-timezone";

import { assertAtcoderPage } from "./atcoder-request";
import { AtcoderSourceIdentity, parseAtcoderSource } from "./atcoder-source.parser";
import { RemoteSyncError } from "./remote-error";
import { RemoteSubmission } from "./remote-judge.types";

export type AtcoderSubmissionDetail = Pick<
  RemoteSubmission,
  "id" | "contestId" | "taskId" | "submittedAt" | "language" | "url" | "sourceCode"
>;

/** Establish submission identity and metadata directly from the detail page, never a list. */
export function parseAtcoderSubmissionDetail(
  html: string,
  expected: Omit<AtcoderSourceIdentity, "taskId">
): AtcoderSubmissionDetail {
  const $ = cheerio.load(html);
  assertAtcoderPage($);
  const fail = (reason: string): never => {
    throw new RemoteSyncError("REMOTE_PARSE_FAILED", {
      stage: "parse",
      reason,
      contestId: expected.contestId,
      submissionId: expected.id
    });
  };
  const info = $("table")
    .toArray()
    .find(table => $(table).find('a[href*="/tasks/"]').length > 0 && $(table).find('a[href^="/users/"]').length > 0);
  if (!info) fail("MISSING_SUBMISSION_TABLE");
  const tasks = $(info).find('a[href*="/tasks/"]').toArray();
  const task =
    tasks.length === 1 &&
    $(tasks[0])
      .attr("href")
      ?.match(/^\/contests\/([\w-]+)\/tasks\/([\w-]+)$/);
  if (!task || task[1] !== expected.contestId) fail("INVALID_TASK_LINK");
  const cell = (...names: string[]) => {
    const row = $(info)
      .find("tr")
      .toArray()
      .find(element => names.includes($(element).children("th").text().trim()));
    return $(row).children("td").first();
  };
  const time = cell("Submission Time", "提出日時").find("time");
  const rawTime = (time.attr("datetime") || time.text() || cell("Submission Time", "提出日時").text()).trim();
  const submitted = /(?:Z|[+-]\d{2}:?\d{2})$/.test(rawTime)
    ? moment.parseZone(rawTime, ["YYYY-MM-DD HH:mm:ssZZ", moment.ISO_8601], true)
    : moment.tz(rawTime, "YYYY-MM-DD HH:mm:ss", true, "Asia/Tokyo");
  if (!submitted.isValid()) fail("INVALID_SUBMISSION_TIME");
  const language = cell("Language", "言語").text().trim();
  if (!language) fail("MISSING_LANGUAGE");
  let sourceCode: string;
  try {
    // Also verifies the heading's submission ID, task link and exactly one matching author.
    sourceCode = parseAtcoderSource(html, { ...expected, taskId: task[2] });
  } catch (error) {
    if (!["REMOTE_SOURCE_MISSING", "REMOTE_SOURCE_TOO_LARGE"].includes(error.message)) throw error;
    // Valid grades can still be imported when code is temporarily unavailable.
  }
  return {
    id: expected.id,
    contestId: expected.contestId,
    taskId: task[2],
    submittedAt: submitted.unix(),
    language,
    url: `https://atcoder.jp/contests/${expected.contestId}/submissions/${expected.id}`,
    ...(sourceCode !== undefined ? { sourceCode } : {})
  };
}
