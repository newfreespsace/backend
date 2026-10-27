import { BadRequestException } from "@nestjs/common";

/* eslint-disable no-control-regex -- Control characters are deliberately rejected in links. */

export function validateNotificationPath(path: string): string {
  if (!path) return "";
  if (!path.startsWith("/") || path.startsWith("//") || /[\\\s\u0000-\u001f\u007f]/.test(path))
    throw new BadRequestException("Only a site-relative notification link is allowed");
  // Reject encoded separators and controls as well as their double-encoded forms.
  let decoded = path;
  try {
    for (let i = 0; i < 3; i++) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
      if (decoded.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(decoded)) throw new Error();
    }
  } catch {
    throw new BadRequestException("Invalid notification link");
  }
  return path;
}

export function validatePushEndpoint(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new BadRequestException("Invalid push endpoint");
  }
  // Push endpoints are supplied by clients. Restrict outbound requests to known
  // browser push providers, preventing subscriptions from becoming an SSRF proxy.
  const allowed =
    url.hostname === "fcm.googleapis.com" ||
    url.hostname === "web.push.apple.com" ||
    url.hostname.endsWith(".push.services.mozilla.com") ||
    url.hostname.endsWith(".notify.windows.com");
  if (
    !allowed ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    (url.port && url.port !== "443")
  )
    throw new BadRequestException("Unsupported push provider");
}

export function validatePushKeys(keys: { p256dh: string; auth: string }): void {
  if (
    !keys ||
    !/^[A-Za-z0-9_-]+={0,2}$/.test(keys.p256dh) ||
    !/^[A-Za-z0-9_-]+={0,2}$/.test(keys.auth) ||
    Buffer.from(keys.p256dh, "base64url").length !== 65 ||
    Buffer.from(keys.auth, "base64url").length !== 16 ||
    Buffer.from(keys.p256dh, "base64url")[0] !== 4
  )
    throw new BadRequestException("Invalid push encryption keys");
}
