export interface ProblemReviewScheduleItem {
  availableAfterDays: number;
  overdueAfterDays: number;
}

export const PROBLEM_REVIEW_SCHEDULE: ProblemReviewScheduleItem[] = [
  { availableAfterDays: 0, overdueAfterDays: 2 },
  { availableAfterDays: 3, overdueAfterDays: 5 },
  { availableAfterDays: 7, overdueAfterDays: 10 },
  { availableAfterDays: 14, overdueAfterDays: 21 }
];

export const PROBLEM_REVIEW_COUNT = PROBLEM_REVIEW_SCHEDULE.length;
