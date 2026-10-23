import * as cheerio from "cheerio";

import { RemoteSyncError } from "./remote-error";

export { ATCODER_USER_AGENT } from "./atcoder-request-profile";

/** Recognize explicit interstitials, not Turnstile widgets embedded in otherwise normal pages. */
export function assertAtcoderPage($: ReturnType<typeof cheerio.load>): void {
  if (
    $("#challenge-form, #cf-challenge-running, #cf-chl-widget").length ||
    $('script[src*="/cdn-cgi/challenge-platform/"][src*="/orchestrate/chl_page/"]').length ||
    $("title")
      .toArray()
      .some(title =>
        /^(?:Just a moment(?:\.{3}|…)?|Attention Required!\s*\|\s*Cloudflare)$/i.test($(title).text().trim())
      )
  )
    throw new RemoteSyncError("REMOTE_VERIFICATION_REQUIRED", { stage: "parse", reason: "CHALLENGE_PAGE" });
  if ($('form[action^="/login"], input[name="password"]').length)
    throw new RemoteSyncError("REMOTE_AUTH_REQUIRED", { stage: "parse", reason: "LOGIN_PAGE" });
}
