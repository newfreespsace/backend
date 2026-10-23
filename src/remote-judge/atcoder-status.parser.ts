import * as cheerio from "cheerio";

import { RemoteSubmission, remoteVerdict, SubmissionMethod } from "./remote-judge.types";
import { RemoteSyncError } from "./remote-error";

/** Only update submissions whose identity and metadata were previously verified in the list. */
export function parseAtcoderStatuses(body: string, known: RemoteSubmission[]): RemoteSubmission[] {
  const fail = (id?: string): never => {
    throw new RemoteSyncError("REMOTE_ATCODER_STATUS_FAILED", {
      stage: "parse",
      reason: "INVALID_STATUS_RESPONSE",
      submissionId: id
    });
  };
  let result: Record<string, { Html: string; Score?: string | number }>;
  try {
    const payload = JSON.parse(body);
    if (!payload?.Result || Array.isArray(payload.Result) || typeof payload.Result !== "object") fail();
    result = payload.Result;
  } catch {
    fail();
  }
  const rows: RemoteSubmission[] = [];
  for (const row of known) {
    if (!Object.prototype.hasOwnProperty.call(result, row.id)) continue;
    const entry = result[row.id];
    if (!entry || typeof entry.Html !== "string" || entry.Html.length > 65536) fail(row.id);
    const $ = cheerio.load(`<table><tbody><tr>${entry.Html}</tr></tbody></table>`);
    const cells = $("tbody > tr").first().children("td");
    const verdict = cells
      .eq(0)
      .text()
      .trim()
      .replace(/\s*\/\s*/g, "/");
    if (!/^(?:AC|WA|CE|RE|TLE|MLE|OLE|IE|QLE|WJ|WR|Judging|\d+\/\d+)$/.test(verdict)) fail(row.id);
    const resource = (index: number, units: Record<string, number>) => {
      const raw = cells.eq(index).text().trim();
      if (!raw || raw === "-") return null;
      const match = raw.match(/^([\d,]+(?:\.\d+)?)\s*(\w+)$/);
      if (!match || !units[match[2]]) fail(row.id);
      const value = Number(match[1].replace(/,/g, "")) * units[match[2]];
      if (!Number.isFinite(value) || value < 0) fail(row.id);
      return value;
    };
    const score = entry.Score === "" ? undefined : entry.Score;
    if (
      score !== undefined &&
      ((typeof score !== "number" && typeof score !== "string") ||
        !/^-?\d+(?:\.\d+)?$/.test(String(score)) ||
        !Number.isFinite(Number(score)))
    )
      fail(row.id);
    rows.push({
      ...row,
      verdict,
      status: remoteVerdict(SubmissionMethod.AtCoder, verdict === "Judging" ? "WJ" : verdict),
      time: resource(1, { ms: 1, s: 1000 }),
      memory: resource(2, { B: 1, KiB: 1024, MiB: 1048576, KB: 1024 }),
      ...(score !== undefined ? { points: Number(score) } : {})
    });
  }
  return rows;
}
