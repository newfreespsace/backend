// Shared by actual requests and sanitized reproduction commands.
export const ATCODER_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";

export function safeAtcoderRequest(value: unknown): { url: string; command: string } | undefined {
  if (typeof value !== "string" || value.length > 1024) return undefined;
  try {
    const url = new URL(value);
    if (url.origin !== "https://atcoder.jp" || url.username || url.password || url.hash) return undefined;
    const list = /^\/contests\/[\w-]{1,100}\/submissions$/.test(url.pathname);
    const status = /^\/contests\/[\w-]{1,100}\/submissions\/me\/status\/json$/.test(url.pathname);
    const detail = /^\/contests\/[\w-]{1,100}\/submissions\/[1-9]\d{0,19}$/.test(url.pathname);
    if (!list && !status && !detail) return undefined;
    const params = url.searchParams;
    if ((status || detail) && url.search) return undefined;
    if (
      list &&
      ([...params.keys()].length !== 3 ||
        !/^[a-zA-Z0-9_.-]{1,64}$/.test(params.get("f.User") || "") ||
        params.get("lang") !== "en" ||
        !/^[1-9]\d{0,9}$/.test(params.get("page") || ""))
    )
      return undefined;
    // Rebuild from allowlisted fields, never from headers, cookies or a stored command.
    url.search = list
      ? new URLSearchParams({ "f.User": params.get("f.User"), lang: "en", page: params.get("page") }).toString()
      : "";
    return {
      url: url.toString(),
      command: [
        "curl --request GET --max-time 20",
        `--user-agent '${ATCODER_USER_AGENT}'`,
        `--header 'Accept: ${status ? "application/json" : "text/html"}'`,
        '--cookie "REVEL_SESSION=$ATCODER_REVEL_SESSION"',
        `'${url.toString()}'`
      ].join(" \\\n  ")
    };
  } catch {
    return undefined;
  }
}
