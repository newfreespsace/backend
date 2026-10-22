import { remoteCodeLanguage } from "./remote-judge.types";

export const MAX_REMOTE_SOURCE_BYTES = 1024 * 1024;

export function validRemoteSource(source: unknown): source is string {
  return (
    typeof source === "string" && source.length > 0 && Buffer.byteLength(source, "utf8") <= MAX_REMOTE_SOURCE_BYTES
  );
}

/** Both remote providers use the same content format and language mapping. */
export function makeRemoteSourceContent(language: string, code: string, previous?: unknown) {
  return {
    ...(previous && typeof previous === "object" ? previous : {}),
    code,
    language: remoteCodeLanguage(language) || "",
    compileAndRunOptions: {}
  };
}
