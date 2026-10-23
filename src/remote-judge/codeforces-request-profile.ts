// Shared by actual requests and sanitized reproduction commands.
export const CODEFORCES_USER_AGENT = "NSOJ-Result-Sync/1.0";

export function safeCodeforcesRequest(value: unknown): { url: string; command: string } | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    if (url.origin !== "https://codeforces.com" || url.username || url.password || url.hash) return undefined;
    const params = url.searchParams;
    const status = url.pathname === "/api/user.status";
    const info = url.pathname === "/api/user.info";
    if (!status && !info) return undefined;
    const allowed = status ? ["handle", "from", "count", "includeSources", "apiKey", "time", "apiSig"] : ["handles"];
    const keys = [...params.keys()];
    if (keys.some(key => !allowed.includes(key)) || new Set(keys).size !== keys.length) return undefined;
    const handle = params.get(status ? "handle" : "handles");
    if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(handle || "")) return undefined;
    if (
      status &&
      (!/^[1-9]\d{0,9}$/.test(params.get("from") || "") ||
        !/^[1-9]\d{0,3}$/.test(params.get("count") || "") ||
        (params.has("includeSources") && params.get("includeSources") !== "true"))
    )
      return undefined;
    const signed = status && params.get("includeSources") === "true";
    // Never retain a signed URL or trust a stored command. Rebuild only public parameters.
    url.search = new URLSearchParams(
      status
        ? {
            handle,
            from: params.get("from"),
            count: params.get("count"),
            ...(signed ? { includeSources: "true" } : {})
          }
        : { handles: handle }
    ).toString();
    const curl = [
      "curl --request GET --max-time 20",
      `--user-agent '${CODEFORCES_USER_AGENT}'`,
      "--header 'Accept: application/json,text/html'",
      signed ? '"$CF_REQUEST_URL"' : `'${url.toString()}'`
    ].join(" \\\n  ");
    // Generate a fresh signature locally; secrets stay in the operator's environment.
    const signing = [
      "CF_REQUEST_URL=\"$(node -e '",
      'const { createHash, randomBytes } = require("node:crypto");',
      "const { CODEFORCES_API_KEY: apiKey, CODEFORCES_API_SECRET: apiSecret } = process.env;",
      'if (!apiKey || !apiSecret) throw new Error("Set CODEFORCES_API_KEY and CODEFORCES_API_SECRET first");',
      `const url = new URL(${JSON.stringify(url.toString())});`,
      'url.searchParams.set("apiKey", apiKey);',
      'url.searchParams.set("time", String(Math.floor(Date.now() / 1000)));',
      "url.searchParams.sort();",
      'const prefix = randomBytes(3).toString("hex");',
      'const signature = createHash("sha512").update(prefix + "/user.status?" + url.searchParams + "#" + apiSecret).digest("hex");',
      'url.searchParams.set("apiSig", prefix + signature);',
      "process.stdout.write(url.toString());",
      "')\" &&"
    ].join("\n");
    return { url: url.toString(), command: signed ? `${signing}\n${curl}` : curl };
  } catch {
    return undefined;
  }
}
