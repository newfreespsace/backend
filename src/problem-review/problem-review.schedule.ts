export interface ProblemReviewScheduleItem {
  availableAfterDays: number;
  overdueAfterDays: number;
}

export interface ProblemReviewPreference {
  enabled: boolean;
  schedule: ProblemReviewScheduleItem[];
}

export const DEFAULT_PROBLEM_REVIEW_SCHEDULE: ProblemReviewScheduleItem[] = [
  { availableAfterDays: 1, overdueAfterDays: 2 },
  { availableAfterDays: 3, overdueAfterDays: 5 },
  { availableAfterDays: 7, overdueAfterDays: 10 },
  { availableAfterDays: 14, overdueAfterDays: 21 }
];

export function getProblemReviewPreference(preference?: ProblemReviewPreference): ProblemReviewPreference {
  return {
    enabled: preference?.enabled === true,
    schedule: preference?.schedule ?? DEFAULT_PROBLEM_REVIEW_SCHEDULE
  };
}

export function calculateReviewWindow(
  anchor: Date,
  schedule: ProblemReviewScheduleItem
): { availableAt: Date; dueAt: Date } {
  // Preserve the existing rule: exclude the completion day, wait N full calendar
  // days, then open the review at midnight in the server's timezone.
  const calculateReviewDate = (daysAfterAnchor: number): Date =>
    new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() + daysAfterAnchor + 1);

  return {
    availableAt: calculateReviewDate(schedule.availableAfterDays),
    dueAt: calculateReviewDate(schedule.overdueAfterDays)
  };
}
