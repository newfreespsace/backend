const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");

require("reflect-metadata");
require("tsconfig-paths").register({ baseUrl: path.resolve(__dirname, "../dist"), paths: { "@/*": ["*"] } });

const { ContestController } = require("../dist/contest/contest.controller");
const { ContestService, ContestPermissionType } = require("../dist/contest/contest.service");

const create = (Type, fields) => Object.assign(Object.create(Type.prototype), fields);

function fixture({ ended, isPublic, canView = true }) {
  const contest = {
    id: 1,
    holderId: 9,
    adminIds: [],
    problemIds: [20],
    startTime: new Date("2000-01-01T00:00:00Z"),
    endTime: new Date(ended ? "2000-01-02T00:00:00Z" : "2100-01-01T00:00:00Z")
  };
  const problem = { id: 20, displayId: 1001, isPublic, locales: ["zh_CN"] };
  const problemService = {
    findProblemById: async () => problem,
    getProblemMeta: async () => ({ ...problem }),
    userHasPermission: async () => false,
    getProblemPreprocessedJudgeInfo: async () => [{}, true],
    getProblemLocalizedTitle: async () => "Example",
    getProblemLocalizedContent: async () => [],
    getProblemSamples: async () => [],
    listProblemFiles: async () => [],
    getUserPermissions: async () => []
  };
  const contestService = create(ContestService, {
    problemService,
    findContestById: async () => contest,
    userHasPermission: async (user, contest, type) => (type === ContestPermissionType.View ? canView : !!user?.isAdmin),
    getContestMeta: () => contest,
    shouldHideNoiResult: async () => false,
    ensureCombinedRanklist: async () => {},
    getContestProblems: async () => []
  });
  return create(ContestController, {
    contestService,
    problemService,
    submissionService: { getUserLatestSubmissionByProblems: async () => new Map() },
    discussionService: { getDiscussionCountOfProblem: async () => 0 }
  });
}

for (const isAdmin of [false, true]) {
  for (const ended of [false, true]) {
    for (const isPublic of [false, true]) {
      test(`problem set access: admin=${isAdmin}, ended=${ended}, public=${isPublic}`, async () => {
        const controller = fixture({ ended, isPublic });
        const response = await controller.getContestProblem(
          { id: 2, isAdmin },
          { contestId: 1, pid: 1, locale: "zh_CN" }
        );
        assert.equal(response.error, undefined);
        assert.equal(response.permissions.canGoToProblemSet, isAdmin || (ended && isPublic));
        assert.equal(response.permissions.ended, ended);
        assert.equal(response.problem.meta.id, 20);
        assert.equal(response.problem.meta.displayId, undefined);
        assert.equal(response.problem.meta.isPublic, undefined);
      });
    }
  }
}

test("problem set link does not bypass contest viewing permission", async () => {
  const controller = fixture({ ended: true, isPublic: true, canView: false });
  const response = await controller.getContestProblem(
    { id: 2, isAdmin: false },
    { contestId: 1, pid: 1, locale: "zh_CN" }
  );
  assert.equal(response.error, "PERMISSION_DENIED");
  assert.equal(response.permissions, undefined);
});
