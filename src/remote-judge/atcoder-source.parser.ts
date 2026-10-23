import * as cheerio from "cheerio";

import { MAX_REMOTE_SOURCE_BYTES } from "./remote-source";
import { assertAtcoderPage } from "./atcoder-request";

export interface AtcoderSourceIdentity {
  id: string;
  contestId: string;
  taskId: string;
  handle: string;
}

export function parseAtcoderSource(html: string, expected: AtcoderSourceIdentity): string {
  // htmlparser2 preserves source CRLF and BOM while decoding HTML entities once.
  const options = {
    xmlMode: false,
    decodeEntities: true,
    // Modern Cheerio selects htmlparser2 through xml; xmlMode:false keeps HTML entity rules.
    // The top-level options also support the older Cheerio typings used by this project.
    xml: { xmlMode: false, decodeEntities: true }
  };
  const $ = cheerio.load(html, options);
  assertAtcoderPage($);
  const headingMatches = $("h2, .h2")
    .toArray()
    .some(
      element =>
        $(element)
          .text()
          .match(/#(\d+)(?:\s|$)/)?.[1] === expected.id
    );
  const info = $("table")
    .toArray()
    .find(
      table =>
        $(table).find(`a[href="/contests/${expected.contestId}/tasks/${expected.taskId}"]`).length > 0 &&
        $(table).find('a[href^="/users/"]').length > 0
    );
  const handles = info
    ? $(info)
        .find('a[href^="/users/"]')
        .toArray()
        .map(element => $(element).attr("href").slice("/users/".length).toLowerCase())
    : [];
  if (!headingMatches || handles.length !== 1 || handles[0] !== expected.handle.toLowerCase())
    throw new Error("REMOTE_SOURCE_IDENTITY_MISMATCH");
  const code = $("#submission-code");
  if (code.length !== 1 || !code.text().trim()) throw new Error("REMOTE_SOURCE_MISSING");
  const source = code.text();
  if (Buffer.byteLength(source, "utf8") > MAX_REMOTE_SOURCE_BYTES) throw new Error("REMOTE_SOURCE_TOO_LARGE");
  return source;
}
