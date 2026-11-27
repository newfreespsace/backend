import type { CodeLanguage } from "@/code-language/code-language.type";
import type { ProblemJudgeInfoTraditional } from "@/problem-type/types/traditional/problem-judge-info.interface";
import type { SubmissionContentTraditional } from "@/problem-type/types/traditional/submission-content.interface";
import type { SubmissionStatus } from "@/submission/submission-status.enum";

export const HACK_INPUT_DEFAULT = 1024 * 1024;
export const HACK_INPUT_MAX = 4 * 1024 * 1024;
export const HACK_OUTPUT_MAX = 4 * 1024 * 1024;
export const HACK_DAILY_LIMIT = 10;

export interface HackProgram {
  language: CodeLanguage;
  code: string;
  compileAndRunOptions: unknown;
}

export interface HackSnapshot {
  judgeInfo: Pick<ProblemJudgeInfoTraditional, "timeLimit" | "memoryLimit" | "fileIo" | "checker" | "extraSourceFiles">;
  validator: HackProgram;
  reference: HackProgram;
  testData: Record<string, string>;
  artifacts: Record<string, string>;
}

export interface HackTask {
  taskId: string;
  snapshot: HackSnapshot;
  input: Buffer;
  referenceOutput?: Buffer;
  target: SubmissionContentTraditional;
  outputLimit: number;
}

export interface HackReport {
  outcome: "Succeeded" | "Failed" | "InvalidInput" | "JudgeError";
  verdict?: SubmissionStatus;
  output?: Buffer;
}

export interface HackDispatcher {
  claim(worker: string): Promise<HackTask | null>;
  heartbeat(worker: string, taskId: string): Promise<boolean>;
  finish(worker: string, taskId: string, report: HackReport): Promise<boolean>;
}
