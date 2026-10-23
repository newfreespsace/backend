import { SubmissionStatus } from "@/submission/submission-status.enum";
import { CodeLanguage } from "@/code-language/code-language.type";

export enum SubmissionMethod {
  Local = "Local",
  Codeforces = "Codeforces",
  AtCoder = "AtCoder"
}

export interface RemoteProblem {
  contestId: string;
  taskId: string;
  url: string;
  fullScore?: number;
}

export interface RemoteSubmission {
  id: string;
  contestId: string;
  taskId: string;
  submittedAt: number;
  verdict: string;
  status: SubmissionStatus;
  language: string;
  time: number | null;
  memory: number | null;
  points?: number;
  passedTestCount?: number;
  testset?: string;
  // Transport-only: strip before storing or returning public remote metadata.
  sourceCode?: string;
  sourceAvailable?: boolean;
  resultSource?: "OriginalSite" | "AtCoderProblems";
  url: string;
}

export interface RemoteSourceSync {
  status: "Pending" | "Available" | "Failed";
  nextAttemptAt?: string;
  failures: number;
  error?: string;
}

export interface RemoteSubmissionInfo extends Omit<RemoteSubmission, "sourceCode"> {
  platform: SubmissionMethod;
  handle: string;
  historical: boolean;
  // Persisted inside the existing remote JSON; omitted from public metadata.
  sourceSync?: RemoteSourceSync;
  sourceStatus?: "Pending" | "Available" | "Failed";
  sourceError?: string;
  sourceRetryAt?: string;
}

// Keep the original compiler name in remote metadata, while preserving NSOJ's language filters.
export function remoteCodeLanguage(language: string): CodeLanguage | null {
  const mappings: [RegExp, CodeLanguage][] = [
    [/c\+\+/i, CodeLanguage.Cpp],
    [/c#|csharp/i, CodeLanguage.CSharp],
    [/f#|fsharp/i, CodeLanguage.FSharp],
    [/\bc(?:\d+|\s|\(|$)/i, CodeLanguage.C],
    [/python|pypy/i, CodeLanguage.Python],
    [/\bjava(?:\d|\s|\(|$)/i, CodeLanguage.Java],
    [/kotlin/i, CodeLanguage.Kotlin],
    [/pascal/i, CodeLanguage.Pascal],
    [/swift/i, CodeLanguage.Swift],
    [/rust/i, CodeLanguage.Rust],
    [/\bgo(?:\d|\s|\(|$)/i, CodeLanguage.Go],
    [/haskell|ghc/i, CodeLanguage.Haskell]
  ];
  return mappings.find(([pattern]) => pattern.test(language || ""))?.[1] || null;
}

export function parseRemoteProblem(method: SubmissionMethod, address?: string): RemoteProblem | null {
  if (method === SubmissionMethod.Local) return null;
  let url: URL;
  try {
    url = new URL(address || "");
  } catch {
    throw new Error("INVALID_REMOTE_URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) throw new Error("INVALID_REMOTE_URL");
  if (method === SubmissionMethod.Codeforces && url.hostname === "codeforces.com") {
    const match = url.pathname.match(
      /^\/(?:problemset\/problem\/(\d+)\/([A-Za-z]\d*)|contest\/(\d+)\/problem\/([A-Za-z]\d*))\/?$/
    );
    if (match) {
      const contestNumber = Number(match[1] || match[3]);
      if (!Number.isSafeInteger(contestNumber) || contestNumber < 1) throw new Error("INVALID_REMOTE_URL");
      const contestId = String(contestNumber);
      const taskId = (match[2] || match[4]).toUpperCase();
      if (`${contestId}:${taskId}`.length > 180) throw new Error("INVALID_REMOTE_URL");
      return { contestId, taskId, url: `https://codeforces.com/problemset/problem/${contestId}/${taskId}` };
    }
  }
  if (method === SubmissionMethod.AtCoder && url.hostname === "atcoder.jp") {
    const match = url.pathname.match(/^\/contests\/([a-zA-Z0-9_-]+)\/tasks\/([a-zA-Z0-9_-]+)\/?$/);
    if (match && `${match[1]}:${match[2]}`.length <= 180)
      return {
        contestId: match[1],
        taskId: match[2],
        url: `https://atcoder.jp/contests/${match[1]}/tasks/${match[2]}`
      };
  }
  throw new Error("INVALID_REMOTE_URL");
}

export function remoteVerdict(platform: SubmissionMethod, verdict?: string): SubmissionStatus {
  const cf: Record<string, SubmissionStatus> = {
    OK: SubmissionStatus.Accepted,
    PARTIAL: SubmissionStatus.PartiallyCorrect,
    COMPILATION_ERROR: SubmissionStatus.CompilationError,
    WRONG_ANSWER: SubmissionStatus.WrongAnswer,
    RUNTIME_ERROR: SubmissionStatus.RuntimeError,
    TIME_LIMIT_EXCEEDED: SubmissionStatus.TimeLimitExceeded,
    MEMORY_LIMIT_EXCEEDED: SubmissionStatus.MemoryLimitExceeded,
    IDLENESS_LIMIT_EXCEEDED: SubmissionStatus.TimeLimitExceeded,
    CHALLENGED: SubmissionStatus.WrongAnswer,
    REJECTED: SubmissionStatus.JudgementFailed,
    SKIPPED: SubmissionStatus.JudgementFailed,
    FAILED: SubmissionStatus.JudgementFailed,
    SECURITY_VIOLATED: SubmissionStatus.RuntimeError,
    CRASHED: SubmissionStatus.SystemError,
    INPUT_PREPARATION_CRASHED: SubmissionStatus.SystemError
  };
  const ac: Record<string, SubmissionStatus> = {
    AC: SubmissionStatus.Accepted,
    WA: SubmissionStatus.WrongAnswer,
    CE: SubmissionStatus.CompilationError,
    RE: SubmissionStatus.RuntimeError,
    TLE: SubmissionStatus.TimeLimitExceeded,
    MLE: SubmissionStatus.MemoryLimitExceeded,
    OLE: SubmissionStatus.OutputLimitExceeded,
    QLE: SubmissionStatus.JudgementFailed,
    IE: SubmissionStatus.SystemError
  };
  if (!verdict || ["TESTING", "SUBMITTED", "WJ", "WR"].includes(verdict) || /^\d+\//.test(verdict))
    return SubmissionStatus.Pending;
  return (platform === SubmissionMethod.Codeforces ? cf : ac)[verdict] || SubmissionStatus.JudgementFailed;
}
