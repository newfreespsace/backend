// Shared by every worker and every CF API caller, including account verification.
export const CODEFORCES_COOLDOWN_KEY = "remote-codeforces-cooldown";
export const CODEFORCES_FAILURES_KEY = "remote-codeforces-failures";
export const CODEFORCES_REQUEST_INTERVAL_MS = 5000;
export const CODEFORCES_HISTORY_INTERVAL_MS = 30000;
export const CODEFORCES_HISTORY_RESCAN_MS = 6 * 3600000;
