const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");

require("reflect-metadata");
require("tsconfig-paths").register({ baseUrl: path.resolve(__dirname, "../dist"), paths: { "@/*": ["*"] } });

const { plainToInstance } = require("class-transformer");
const { validate } = require("class-validator");
const { UserPreferenceDto } = require("../dist/user/dto/user-preference.dto");
const { UserPreferenceEntity } = require("../dist/user/user-preference.entity");
const { UserService } = require("../dist/user/user.service");
const { ProblemReviewService } = require("../dist/problem-review/problem-review.service");
const { ProblemReviewEntity } = require("../dist/problem-review/problem-review.entity");
const { SubmissionEntity } = require("../dist/submission/submission.entity");
const {
  calculateReviewWindow,
  DEFAULT_PROBLEM_REVIEW_SCHEDULE,
  getProblemReviewPreference
} = require("../dist/problem-review/problem-review.schedule");

const schedule = [
  { availableAfterDays: 2, overdueAfterDays: 4 },
  { availableAfterDays: 8, overdueAfterDays: 12 }
];
const config = (enabled = true, rounds = schedule) => ({ enabled, schedule: rounds });
const submission = (id = 20, submitTime = new Date()) => ({ id, submitterId: 1, problemId: 2, submitTime });
const review = (overrides = {}) => ({
  id: 1,
  userId: 1,
  problemId: 2,
  completedReviewCount: 0,
  firstAcceptedSubmissionId: 10,
  firstAcceptedAt: new Date(2020, 0, 1, 14),
  lastReviewedAt: null,
  lastReviewSubmissionId: null,
  availableAt: new Date(2020, 0, 3),
  dueAt: new Date(2020, 0, 4),
  completedAt: null,
  ...overrides
});

// Repository doubles keep these tests independent of the development database.
// They exercise the real services and DTO validation, including the shared lock.
function fixture(preference, rows = [], firstAccepted = submission()) {
  let storedPreference = { userId: 1, preference: { theme: "dark", problemReview: preference } };
  const locks = [];
  let writes = 0;
  const preferenceRepository = {
    findOne: async options => {
      locks.push(options.lock?.mode);
      return structuredClone(storedPreference);
    },
    findOneBy: async () => structuredClone(storedPreference),
    save: async value => {
      storedPreference = structuredClone(value);
    }
  };
  const reviewRepository = {
    findOneBy: async where => rows.find(row => row.userId === where.userId && row.problemId === where.problemId),
    findBy: async where =>
      rows.filter(row => row.userId === where.userId && row.completedAt === null).map(row => ({ ...row })),
    create: value => value,
    save: async values => {
      for (const value of values)
        Object.assign(
          rows.find(row => row.id === value.id),
          value
        );
      writes += values.length;
    },
    createQueryBuilder: () => {
      let mode, data;
      const params = {};
      const builder = {
        insert() {
          mode = "insert";
          return this;
        },
        update() {
          mode = "update";
          return this;
        },
        into() {
          return this;
        },
        values(value) {
          data = value;
          return this;
        },
        set(value) {
          data = value;
          return this;
        },
        orIgnore() {
          return this;
        },
        where(sql, values) {
          Object.assign(params, values);
          return this;
        },
        andWhere(sql, values) {
          Object.assign(params, values);
          return this;
        },
        orderBy() {
          return this;
        },
        async getMany() {
          return rows.filter(
            row =>
              row.userId === params.userId &&
              !row.completedAt &&
              row.completedReviewCount < params.reviewCount &&
              row.availableAt <= params.now
          );
        },
        async execute() {
          writes++;
          if (mode === "insert") rows.push({ id: rows.length + 1, ...data });
          else
            Object.assign(
              rows.find(row => row.id === params.id && row.completedReviewCount === params.completedReviewCount),
              data
            );
        }
      };
      return builder;
    }
  };
  const submissionRepository = { findOne: async () => firstAccepted, findBy: async () => [] };
  const manager = {
    getRepository(entity) {
      if (entity === UserPreferenceEntity) return preferenceRepository;
      if (entity === ProblemReviewEntity) return reviewRepository;
      if (entity === SubmissionEntity) return submissionRepository;
      throw new Error(`Unexpected repository: ${entity.name}`);
    },
    transaction: async callback => callback(manager)
  };
  reviewRepository.manager = manager;
  const problemService = {
    findProblemsByExistingIds: async ids => ids.map(id => ({ id, locales: ["en_US"] })),
    userHasPermission: async () => true,
    getProblemMeta: async problem => problem,
    getProblemLocalizedTitle: async () => "Test problem"
  };
  const reviews = new ProblemReviewService(reviewRepository, submissionRepository, {}, problemService);
  // Only updateUserPreference is used; no other UserService dependency is needed.
  const users = Object.assign(Object.create(UserService.prototype), { connection: manager });
  return {
    reviews,
    users,
    rows,
    locks,
    get writes() {
      return writes;
    },
    get preference() {
      return storedPreference.preference;
    }
  };
}

test("missing preferences are disabled, with the original four-round preset", () => {
  assert.deepEqual(getProblemReviewPreference(), { enabled: false, schedule: DEFAULT_PROBLEM_REVIEW_SCHEDULE });
  assert.equal(getProblemReviewPreference(null).enabled, false);
});

test("dates exclude the completion day and roll across month/year boundaries", () => {
  const window = calculateReviewWindow(new Date(2026, 8, 5, 23, 59), { availableAfterDays: 1, overdueAfterDays: 2 });
  assert.equal(window.availableAt.getTime(), new Date(2026, 8, 7).getTime());
  assert.equal(window.dueAt.getTime(), new Date(2026, 8, 8).getTime());
  assert.equal(
    calculateReviewWindow(new Date(2026, 11, 31), schedule[0]).availableAt.getTime(),
    new Date(2027, 0, 3).getTime()
  );
});

test("DTO accepts absent settings and valid custom schedules", async () => {
  for (const problemReview of [
    undefined,
    config(),
    config(false),
    config(
      true,
      Array.from({ length: 10 }, () => schedule[0])
    )
  ]) {
    const dto = plainToInstance(UserPreferenceDto, { theme: "", problemReview });
    assert.deepEqual(await validate(dto, { whitelist: true, forbidNonWhitelisted: true }), []);
  }
});

test("DTO rejects invalid counts, days, deadlines and switches", async () => {
  const invalid = [
    [],
    { enabled: "true", schedule },
    { enabled: true },
    config(true, []),
    config(
      true,
      Array.from({ length: 11 }, () => schedule[0])
    ),
    ...[0, -1, 1.5, "2", null, 366].map(value => config(true, [{ availableAfterDays: value, overdueAfterDays: 4 }])),
    ...[1, 2, 2.5, 366, null].map(value => config(true, [{ availableAfterDays: 2, overdueAfterDays: value }])),
    config(true, [null]),
    config(true, [[]]),
    config(true, [[schedule[0]]]),
    config(true, [{ availableAfterDays: 2, overdueAfterDays: 4, extra: true }])
  ];
  for (const problemReview of invalid) {
    const errors = await validate(plainToInstance(UserPreferenceDto, { theme: "", problemReview }), {
      whitelist: true,
      forbidNonWhitelisted: true
    });
    assert.ok(errors.length, JSON.stringify(problemReview));
  }
});

test("default-off and explicitly disabled users neither create nor advance reviews", async () => {
  for (const preference of [undefined, config(false)]) {
    for (const rows of [[], [review()]]) {
      const f = fixture(preference, rows);
      await f.reviews.onAcceptedSubmission(submission());
      assert.equal(f.writes, 0);
      assert.deepEqual(f.locks, ["pessimistic_write"]);
      assert.equal(await f.reviews.getCurrentProblemReview({ id: 1 }, 2), null);
      assert.deepEqual(await f.reviews.queryDueReviews({ id: 1 }, "en_US", 0, 20), {
        enabled: false,
        count: 0,
        overdueCount: 0,
        result: []
      });
    }
  }
});

test("first accepted submission creates a plan with the user's schedule and contest context", async () => {
  const accepted = { ...submission(), contestId: 3, contestProblemIndex: 1 };
  const f = fixture(config(), [], accepted);
  await f.reviews.onAcceptedSubmission(accepted);
  const row = f.rows[0];
  assert.equal(row.completedReviewCount, 0);
  assert.equal(row.sourceContestId, 3);
  assert.equal(row.sourceContestProblemIndex, 1);
  assert.equal(
    row.availableAt.getTime(),
    calculateReviewWindow(row.firstAcceptedAt, schedule[0]).availableAt.getTime()
  );
  await f.reviews.onAcceptedSubmission(accepted);
  assert.equal(f.writes, 1);
});

test("enabling does not import previously accepted problems", async () => {
  const f = fixture(config(), [], submission(10));
  await f.reviews.onAcceptedSubmission(submission(20));
  assert.equal(f.rows.length, 0);
});

test("an early submission does not count; the opening boundary counts once", async () => {
  const row = review();
  const f = fixture(config(), [row]);
  await f.reviews.onAcceptedSubmission(submission(20, new Date(row.availableAt.getTime() - 1)));
  assert.equal(f.writes, 0);
  await f.reviews.onAcceptedSubmission(submission(21, row.availableAt));
  assert.equal(row.completedReviewCount, 1);
  assert.equal(row.dueAt.getTime(), calculateReviewWindow(row.lastReviewedAt, schedule[1]).dueAt.getTime());
  await f.reviews.onAcceptedSubmission(submission(21));
  assert.equal(f.writes, 1);
});

test("the configured final round completes the plan and it stays complete", async () => {
  const row = review();
  const f = fixture(config(true, [schedule[0]]), [row]);
  await f.reviews.onAcceptedSubmission(submission());
  assert.equal(row.completedReviewCount, 1);
  assert.ok(row.completedAt);
  await f.users.updateUserPreference({ id: 1 }, { problemReview: config() });
  await f.reviews.onAcceptedSubmission(submission(21));
  assert.equal(row.completedReviewCount, 1);
  assert.equal(await f.reviews.getCurrentProblemReview({ id: 1 }, 2), null);
});

test("changing rules recomputes unfinished plans from the correct anchor and preserves other users", async () => {
  const rows = [
    review(),
    review({ id: 2, problemId: 3, completedReviewCount: 1, lastReviewedAt: new Date(2020, 1, 1) }),
    review({ id: 3, userId: 2 })
  ];
  const f = fixture(config(), rows);
  const next = [
    { availableAfterDays: 5, overdueAfterDays: 7 },
    { availableAfterDays: 20, overdueAfterDays: 25 }
  ];
  const otherUserDate = rows[2].availableAt.getTime();
  await f.users.updateUserPreference({ id: 1 }, { theme: "light", problemReview: config(true, next) });
  assert.equal(rows[0].availableAt.getTime(), new Date(2020, 0, 7).getTime());
  assert.equal(rows[1].availableAt.getTime(), new Date(2020, 1, 22).getTime());
  assert.equal(rows[1].completedReviewCount, 1);
  assert.equal(rows[2].availableAt.getTime(), otherUserDate);
  assert.equal(f.preference.theme, "light");
  assert.deepEqual(f.locks, ["pessimistic_write"]);
});

test("reducing rounds marks reached plans complete without reopening previously completed plans", async () => {
  const completedDate = new Date(2020, 2, 1);
  const rows = [
    review({ completedReviewCount: 1 }),
    review({ id: 2, completedReviewCount: 2, completedAt: completedDate })
  ];
  const f = fixture(config(), rows);
  await f.users.updateUserPreference({ id: 1 }, { problemReview: config(true, [schedule[0]]) });
  assert.ok(rows[0].completedAt);
  assert.equal(rows[1].completedAt.getTime(), completedDate.getTime());
  await f.users.updateUserPreference({ id: 1 }, { problemReview: config() });
  assert.ok(rows[0].completedAt);
});

test("disabling and re-enabling preserves dates and progress", async () => {
  const row = review();
  const f = fixture(config(), [row]);
  const original = structuredClone(row);
  await f.users.updateUserPreference({ id: 1 }, { problemReview: config(false) });
  await f.reviews.onAcceptedSubmission(submission());
  await f.users.updateUserPreference({ id: 1 }, { problemReview: config() });
  assert.deepEqual(row, original);
  assert.equal(f.writes, 0);
  assert.equal((await f.reviews.getCurrentProblemReview({ id: 1 }, 2)).overdue, true);
});

test("queries expose the user's total, exclude completed plans, and retain pagination", async () => {
  const f = fixture(config(), [
    review(),
    review({ id: 2, problemId: 3 }),
    review({ id: 3, userId: 2 }),
    review({ id: 4, completedAt: new Date() })
  ]);
  const current = await f.reviews.getCurrentProblemReview({ id: 1 }, 2);
  assert.equal(current.totalReviewCount, 2);
  const result = await f.reviews.queryDueReviews({ id: 1 }, "en_US", 1, 1);
  assert.equal(result.enabled, true);
  assert.equal(result.count, 2);
  assert.equal(result.overdueCount, 2);
  assert.equal(result.result.length, 1);
  assert.equal(result.result[0].problem.id, 3);
  assert.equal(result.result[0].totalReviewCount, 2);
});
