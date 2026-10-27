function isSensitiveField(key: string): boolean {
  return /^(apiKey|apiSecret|atcoderSession|token|endpoint|p256dh|auth|bindingVersion)$/i.test(key);
}

/** Make a logging-only copy. Never mutate credentials used by the controller. */
export function redactRequestBody(body: unknown): unknown {
  if (Array.isArray(body)) return body.map(redactRequestBody);
  if (!body || typeof body !== "object") return body;
  return Object.fromEntries(
    Object.entries(body).map(([key, value]) => [key, isSensitiveField(key) ? "[REDACTED]" : redactRequestBody(value)])
  );
}

/** Preserve the path and nonsensitive query fields, including repeated and encoded parameter names. */
export function redactRequestUrl(url: string): string {
  return url.replace(/([?&])([^=&#]+)=([^&#]*)/g, (field, separator: string, key: string) => {
    try {
      return isSensitiveField(decodeURIComponent(key.replace(/\+/g, " "))) ? `${separator}${key}=[REDACTED]` : field;
    } catch {
      return field;
    }
  });
}
