import * as cheerio from "cheerio";

import { SubmissionStatus } from "@/submission/submission-status.enum";

import { RemoteSubmission, remoteVerdict, SubmissionMethod } from "./remote-judge.types";
import { RemoteSyncError } from "./remote-error";

export type AtcoderStatusUpdate = Pick<RemoteSubmission, "id" | "verdict" | "status" | "time" | "memory" | "points">;

/** Status responses can discover IDs, but do not establish task, language or submission time. */
export function parseAtcoderStatusResponse(body: string): AtcoderStatusUpdate[] {
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
  const rows: AtcoderStatusUpdate[] = [];
  for (const [id, entry] of Object.entries(result)) {
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) fail();
    if (!entry || typeof entry.Html !== "string" || entry.Html.length > 65536) fail(id);
    const $ = cheerio.load(`<table><tbody><tr>${entry.Html}</tr></tbody></table>`);
    const cells = $("tbody > tr").first().children("td");
    const verdict = cells
      .eq(0)
      .text()
      .trim()
      .replace(/\s*\/\s*/g, "/");
    if (
      !/^(?:AC|WA|CE|RE|TLE|MLE|OLE|IE|QLE|WJ|WR|Judging|\d+\/\d+(?:\s+(?:AC|WA|CE|RE|TLE|MLE|OLE|IE|QLE))?)$/.test(
        verdict
      )
    )
      fail(id);
    const resource = (index: number, units: Record<string, number>) => {
      const raw = cells.eq(index).text().trim();
      if (!raw || raw === "-") return null;
      const match = raw.match(/^(?:>\s*)?([\d,]+(?:\.\d+)?)\s*(\w+)$/);
      if (!match || !units[match[2]]) fail(id);
      const value = Number(match[1].replace(/,/g, "")) * units[match[2]];
      if (!Number.isFinite(value) || value < 0) fail(id);
      return value;
    };
    const score = entry.Score === "" ? undefined : entry.Score;
    if (
      score !== undefined &&
      ((typeof score !== "number" && typeof score !== "string") ||
        !/^-?\d+(?:\.\d+)?$/.test(String(score)) ||
        !Number.isFinite(Number(score)))
    )
      fail(id);
    rows.push({
      id,
      verdict,
      status: cells.eq(0).hasClass("waiting-judge")
        ? SubmissionStatus.Pending
        : remoteVerdict(SubmissionMethod.AtCoder, verdict === "Judging" ? "WJ" : verdict),
      time: resource(1, { ms: 1, s: 1000 }),
      memory: resource(2, { B: 1, KiB: 1024, MiB: 1048576, KB: 1024 }),
      ...(score !== undefined ? { points: Number(score) } : {})
    });
  }
  return rows;
}

/** Only import statuses after their identity and metadata have been verified in the list. */
export function parseAtcoderStatuses(body: string, known: RemoteSubmission[]): RemoteSubmission[] {
  const updates = new Map(parseAtcoderStatusResponse(body).map(row => [row.id, row]));
  return known.filter(row => updates.has(row.id)).map(row => ({ ...row, ...updates.get(row.id) }));
}
