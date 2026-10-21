/** Make a logging-only copy. Never mutate credentials used by the controller. */
export function redactRequestBody(body: unknown): unknown {
  if (Array.isArray(body)) return body.map(redactRequestBody);
  if (!body || typeof body !== "object") return body;
  return Object.fromEntries(
    Object.entries(body).map(([key, value]) => [
      key,
      /^(apiKey|apiSecret|atcoderSession)$/i.test(key) ? "[REDACTED]" : redactRequestBody(value)
    ])
  );
}
