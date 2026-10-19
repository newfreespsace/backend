const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");

require("reflect-metadata");
require("tsconfig-paths").register({ baseUrl: path.resolve(__dirname, "../dist"), paths: { "@/*": ["*"] } });

const { DataSource } = require("typeorm");
const { GroupService } = require("../dist/group/group.service");
const { SubmissionService, SubmissionPermissionType } = require("../dist/submission/submission.service");
const { SubmissionController } = require("../dist/submission/submission.controller");
const { ContestService, ContestPermissionType } = require("../dist/contest/contest.service");
const { ContestAccessGuard } = require("../dist/contest/contest-access.guard");
const { SectionService } = require("../dist/training/section.service");
const { SiteSettingService } = require("../dist/site-setting/site-setting.service");
const { SiteSettingController } = require("../dist/site-setting/site-setting.controller");

const teacher = { id: 1, username: "teacher", isAdmin: false };
const member = { id: 2, username: "member", isAdmin: false };
const outsider = { id: 3, username: "outsider", isAdmin: false };
const users = [teacher, member, outsider];
const problem = { id: 20, locales: ["zh-CN"] };
const runningContest = {
  id: 30,
  groupId: 10,
  type: "noi",
  holderId: 9,
  adminIds: [],
  isPublic: true,
  hideStatistics: true,
  startTime: new Date(Date.now() - 60000),
  endTime: new Date(Date.now() + 60000)
};
const submission = {
  id: 100,
  submitterId: member.id,
  problemId: problem.id,
  contestId: runningContest.id,
  score: 65,
  status: "PartiallyCorrect",
  isPublic: false
};
const create = (Type, fields) => Object.assign(Object.create(Type.prototype), fields);

function groupFixture() {
  const memberships = [
    { userId: teacher.id, groupId: 10, isGroupAdmin: true },
    { userId: member.id, groupId: 10, isGroupAdmin: false },
    { userId: teacher.id, groupId: 11, isGroupAdmin: true },
    { userId: member.id, groupId: 11, isGroupAdmin: false },
    { userId: teacher.id, groupId: 12, isGroupAdmin: false },
    { userId: outsider.id, groupId: 12, isGroupAdmin: false }
  ];
  const source = new DataSource({ type: "mysql", database: "test" });
  const queries = [];
  const matches = (row, where) => Object.entries(where).every(([key, value]) => row[key] === value);
  const service = create(GroupService, {
    groupMembershipRepository: {
      findBy: async where => memberships.filter(row => matches(row, where)),
      findOneBy: async where => memberships.find(row => matches(row, where)),
      countBy: async where => memberships.filter(row => matches(row, where)).length,
      createQueryBuilder(alias) {
        const builder = source.createQueryBuilder().from("group_membership", alias);
        const matchingMembers = () => {
          const parameters = builder.getParameters();
          const groupIds = memberships
            .filter(row => row.userId === parameters.adminUserId && row.isGroupAdmin)
            .map(row => row.groupId);
          return memberships.filter(
            row =>
              groupIds.includes(row.groupId) &&
              (parameters.memberUserId == null || row.userId === parameters.memberUserId)
          );
        };
        builder.getRawMany = async () =>
          [...new Set(matchingMembers().map(row => row.userId))].map(userId => ({ userId: String(userId) }));
        builder.getCount = async () => matchingMembers().length;
        queries.push(builder);
        return builder;
      }
    },
    findGroupsByExistingIds: async ids => ids.map(id => ({ id, name: `Group ${id}` })),
    findGroupById: async id => ({ id, name: `Group ${id}` })
  });
  return { service, memberships, queries, source };
}

function fixture({ pending = false, contest = runningContest, threshold = 400 } = {}) {
  const group = groupFixture();
  const contestService = create(ContestService, {
    groupService: group.service,
    userPrivilegeService: { userHasPrivilege: async user => !!user?.isAdmin },
    findContestById: async () => contest,
    queryContests: async () => [[contest], 1],
    getActiveGroupContestsForUser: async () => (contestService.isRunning(contest) ? [contest] : [])
  });
  const record = { ...submission, ...(pending ? { status: "Pending", score: null } : {}) };
  const progress = { progressType: "Finished", score: 65, status: "PartiallyCorrect" };
  const detail = { content: { code: "int main() {}", language: "cpp" }, result: progress, fileUuid: "answer-file" };
  let queryArgs;
  let subscription;
  const submissionService = create(SubmissionService, {
    contestService,
    siteSettingService: {
      getPreference: async () => ({ security: { otherSubmissionCodeMinAcceptedProblems: threshold } })
    },
    groupService: group.service,
    problemService: { userHasPermission: async () => false, findProblemById: async () => problem },
    userPrivilegeService: { userHasPrivilege: async user => !!user?.isAdmin },
    findSubmissionById: async () => record,
    getSubmissionDetail: async () => detail,
    querySubmissions: async (...args) => {
      queryArgs = args;
      return { result: [record], hasSmallerId: false, hasLargerId: false };
    }
  });
  const controller = create(SubmissionController, {
    groupService: group.service,
    contestService,
    submissionService,
    userPrivilegeService: { userHasPrivilege: async user => !!user?.isAdmin },
    problemService: {
      findProblemById: async () => problem,
      userHasPermission: async () => false,
      findProblemsByExistingIds: async ids => ids.map(() => problem),
      getProblemMeta: async value => value,
      getProblemLocalizedTitle: async () => "Problem"
    },
    userService: {
      findUserById: async id => users.find(user => user.id === id),
      findUserByUsername: async name => users.find(user => user.username === name),
      findUsersByExistingIds: async ids => ids.map(id => users.find(user => user.id === id)),
      getUserMeta: async value => value
    },
    configService: { config: { queryLimit: { submissions: 50 } } },
    siteSettingService: {
      getPreference: async () => ({ security: { hideSubmissionTestcaseDetailsForNormalUsers: false } })
    },
    submissionProgressService: {
      getPendingSubmissionProgress: async () => progress,
      getRecentlyFinishedFirstAccepted: async () => null
    },
    submissionProgressGateway: {
      encodeSubscription: value => {
        subscription = value;
        return "signed-key";
      }
    },
    fileService: { signProxyDownloadLink: async () => "signed-answer-url" }
  });
  return {
    group,
    contestService,
    submissionService,
    controller,
    record,
    detail,
    get queryArgs() {
      return queryArgs;
    },
    get subscription() {
      return subscription;
    }
  };
}

test("managed membership uses only administered groups, deduplicates users and reflects revocation", async () => {
  const { service, memberships, queries } = groupFixture();
  assert.deepEqual(await service.getAdminGroupIdsByUserId(teacher.id), [10, 11]);
  assert.deepEqual(await service.getManagedMemberIds(teacher.id), [teacher.id, member.id]);
  assert.equal(await service.isGroupAdminOfUser(teacher.id, member.id), true);
  assert.equal(await service.isGroupAdminOfUser(teacher.id, outsider.id), false);
  assert.equal(await service.isGroupAdminOfUser(member.id, teacher.id), false);
  assert.match(queries[0].getQuery(), /INNER JOIN.*group_membership.*adminMembership/);
  assert.deepEqual(queries[0].getParameters(), { adminUserId: teacher.id, isGroupAdmin: true });
  memberships.filter(row => row.userId === teacher.id).forEach(row => (row.isGroupAdmin = false));
  assert.equal(await service.isGroupAdminOfUser(teacher.id, member.id), false);
  assert.deepEqual(await service.getManagedMemberIds(teacher.id), []);
});

test("group admins can read private group submissions without receiving mutation permissions", async () => {
  const { submissionService } = fixture();
  assert.equal(await submissionService.userHasPermission(teacher, submission, SubmissionPermissionType.View), true);
  assert.equal(
    await submissionService.userHasPermission(
      teacher,
      { ...submission, submitterId: outsider.id },
      SubmissionPermissionType.View
    ),
    false
  );
  assert.equal(await submissionService.userHasPermission(outsider, submission, SubmissionPermissionType.View), false);
  assert.equal(await submissionService.userHasPermission(null, submission, SubmissionPermissionType.View), false);
  for (const type of ["Cancel", "Rejudge", "ManagePublicness", "Delete"])
    assert.equal(await submissionService.userHasPermission(teacher, submission, type), false, type);
  assert.equal(await submissionService.userHasPermission(member, submission, SubmissionPermissionType.View), true);
});

test("group admin detail and answer download expose code and NOI grades during the contest", async () => {
  const { controller, detail } = fixture();
  const result = await controller.getSubmissionDetail(teacher, { submissionId: submission.id, locale: "zh-CN" });
  assert.equal(result.error, undefined);
  assert.deepEqual(result.content, detail.content);
  assert.equal(result.meta.score, 65);
  assert.equal(result.meta.status, "PartiallyCorrect");
  assert.equal(result.progress.score, 65);
  for (const key of ["permissionRejudge", "permissionCancel", "permissionSetPublic", "permissionDelete"])
    assert.equal(result[key], false, key);
  assert.deepEqual(await controller.downloadSubmissionFile(teacher, { submissionId: submission.id }), {
    url: "signed-answer-url"
  });
});

test("group admin pending detail subscribes to live result updates", async () => {
  const f = fixture({ pending: true });
  const result = await f.controller.getSubmissionDetail(teacher, { submissionId: submission.id, locale: "zh-CN" });
  assert.equal(result.progressSubscriptionKey, "signed-key");
  assert.deepEqual(f.subscription.submissionIds, [submission.id]);
  assert.deepEqual(f.subscription.hideTestcaseDetailsSubmissionIds, []);
});

test("ordinary contestants remain restricted and cannot read or download other users' submissions", async () => {
  const { controller } = fixture();
  assert.deepEqual(await controller.getSubmissionDetail(outsider, { submissionId: submission.id, locale: "zh-CN" }), {
    error: "PERMISSION_DENIED"
  });
  assert.deepEqual(await controller.downloadSubmissionFile(outsider, { submissionId: submission.id }), {
    error: "PERMISSION_DENIED"
  });
  const own = await controller.getSubmissionDetail(member, { submissionId: submission.id, locale: "zh-CN" });
  assert.equal(own.meta.score, null);
  assert.equal(own.meta.status, "Submitted");
  assert.equal(own.progress.score, null);
});

test("assessment lists are scoped to self and managed members, including private contest grades", async () => {
  const f = fixture();
  const result = await f.controller.querySubmission(teacher, { locale: "zh-CN", takeCount: 20 });
  assert.deepEqual(f.queryArgs[11], [teacher.id, member.id]);
  assert.equal(f.queryArgs[8], false, "private submissions are included inside the authorized scope");
  assert.equal(result.submissions[0].score, 65);
  assert.equal(result.submissions[0].status, "PartiallyCorrect");
  await f.controller.querySubmission(teacher, {
    contestId: runningContest.id,
    submitter: member.username,
    locale: "zh-CN",
    takeCount: 20,
    status: "PartiallyCorrect"
  });
  assert.equal(f.queryArgs[3], member.id);
  assert.equal(f.queryArgs[5], "PartiallyCorrect");
  assert.deepEqual(await f.controller.querySubmission(teacher, { submitter: outsider.username }), {
    error: "PERMISSION_DENIED"
  });
});

test("ordinary assessment lists stay scoped to self and reject other submitter filters", async () => {
  const f = fixture();
  f.contestService.getActiveGroupContestsForUser = async () => [];
  await f.controller.querySubmission(outsider, { locale: "zh-CN", takeCount: 20 });
  assert.deepEqual(f.queryArgs[11], [outsider.id]);
  assert.deepEqual(await f.controller.querySubmission(outsider, { submitter: member.username }), {
    error: "PERMISSION_DENIED"
  });
});

const endedContest = { ...runningContest, endTime: new Date(Date.now() - 1000) };

test("configured solved-problem threshold includes the boundary and applies only to readable submissions", async () => {
  for (const threshold of [0, 400, 600]) {
    const { submissionService: service } = fixture({ threshold, contest: endedContest });
    service.contestService.userHasPermission = async () => true;
    service.problemService.userHasPermission = async () => true;
    for (const count of [Math.max(0, threshold - 1), threshold, threshold + 1]) {
      const user = { ...outsider, acceptedProblemCount: count };
      const expected = count >= threshold;
      assert.equal(await service.userHasPermission(user, submission, "View"), expected);
      assert.equal(
        await service.userHasPermission(user, { ...submission, contestId: null, isPublic: true }, "View"),
        expected
      );
      assert.equal(
        await service.userHasPermission(user, { ...submission, contestId: null, isPublic: false }, "View"),
        false
      );
      for (const type of ["Cancel", "Rejudge", "ManagePublicness", "Delete"]) {
        service.problemService.userHasPermission = async () => false;
        assert.equal(await service.userHasPermission(user, submission, type), false);
        service.problemService.userHasPermission = async () => true;
      }
    }
  }
});

test("qualified users can read and download official and post-contest submissions after the contest ends", async () => {
  const user = { ...outsider, acceptedProblemCount: 400 };
  for (const contestPhase of ["official", "post_contest"]) {
    const f = fixture({ contest: endedContest });
    Object.assign(f.record, { contestPhase });
    f.contestService.userHasPermission = async () => true;
    const result = await f.controller.getSubmissionDetail(user, { submissionId: submission.id, locale: "zh-CN" });
    assert.deepEqual(result.content, f.detail.content);
    assert.equal(result.meta.score, 65);
    assert.equal(result.meta.contestPhase, contestPhase);
    assert.deepEqual(await f.controller.downloadSubmissionFile(user, { submissionId: submission.id }), {
      url: "signed-answer-url"
    });
    for (const key of ["permissionRejudge", "permissionCancel", "permissionSetPublic", "permissionDelete"])
      assert.equal(result[key], false);
    const list = await f.controller.querySubmission(user, {
      contestId: endedContest.id,
      submitter: member.username,
      locale: "zh-CN",
      takeCount: 20
    });
    assert.equal(list.error, undefined);
    assert.equal(list.permissionViewOthers, true);
    assert.equal(f.queryArgs[3], member.id);
    assert.equal(f.queryArgs[8], false);
    assert.equal(f.queryArgs[10], false);
    assert.deepEqual(f.queryArgs[12], [endedContest.id]);
  }
});

test("qualification does not bypass running, upcoming, inaccessible or missing contests", async () => {
  const user = { ...outsider, acceptedProblemCount: 1000 };
  for (const contest of [runningContest, { ...runningContest, startTime: new Date(Date.now() + 30000) }]) {
    const f = fixture({ contest });
    f.contestService.userHasPermission = async () => true;
    assert.equal(await f.submissionService.userHasPermission(user, submission, "View"), false);
    f.record.isPublic = true;
    assert.deepEqual(await f.controller.downloadSubmissionFile(user, { submissionId: submission.id }), {
      error: "PERMISSION_DENIED"
    });
    const result = await f.controller.querySubmission(user, { contestId: contest.id, submitter: member.username });
    assert.equal(result.error, "PERMISSION_DENIED");
  }
  const f = fixture({ contest: endedContest });
  assert.equal(await f.submissionService.userHasPermission(user, submission, "View"), false, "different group");
  f.contestService.findContestById = async () => null;
  assert.equal(await f.submissionService.userHasPermission(user, submission, "View"), false);
});

test("global qualified lists include public practice submissions and only accessible ended contests", async () => {
  const f = fixture({ contest: endedContest });
  f.contestService.queryContests = async () => [[endedContest, { ...runningContest, id: 31 }], 2];
  const result = await f.controller.querySubmission(
    { ...outsider, acceptedProblemCount: 400 },
    { locale: "zh-CN", takeCount: 20 }
  );
  assert.equal(result.permissionViewOthers, true);
  assert.deepEqual(f.queryArgs[11], [outsider.id]);
  assert.deepEqual(f.queryArgs[12], [endedContest.id]);
});

test("changing the saved threshold immediately changes viewing permissions", async () => {
  const { submissionService: service } = fixture({ contest: endedContest });
  const preference = { security: { otherSubmissionCodeMinAcceptedProblems: 400 } };
  service.siteSettingService.getPreference = async () => preference;
  service.contestService.userHasPermission = async () => true;
  const user = { ...outsider, acceptedProblemCount: 400 };
  assert.equal(await service.userHasPermission(user, submission, "View"), true);
  preference.security.otherSubmissionCodeMinAcceptedProblems = 401;
  assert.equal(await service.userHasPermission(user, submission, "View"), false);
});

test("site settings persist the threshold, preserve other settings and reject invalid values", async () => {
  let setting = null;
  const service = create(SiteSettingService, {
    siteSettingRepository: {
      findOneBy: async () => setting,
      save: async entity => {
        setting = entity;
      }
    },
    configService: {
      config: { preference: { security: { otherSubmissionCodeMinAcceptedProblems: 400, allowRegister: true } } }
    }
  });
  assert.equal((await service.getPreference()).security.otherSubmissionCodeMinAcceptedProblems, 400);
  const controller = new SiteSettingController(service);
  const patch = value => ({ preference: { security: { otherSubmissionCodeMinAcceptedProblems: value } } });
  assert.equal((await controller.updatePreference(outsider, patch(0))).error, "PERMISSION_DENIED");
  for (const value of [-1, 0.5, "400", null, Number.MAX_SAFE_INTEGER + 1])
    await assert.rejects(
      controller.updatePreference({ id: 9, isAdmin: true }, patch(value)),
      /non-negative safe integer/
    );
  assert.equal(setting, null);
  for (const value of [0, 600]) {
    const result = await controller.updatePreference({ id: 9, isAdmin: true }, patch(value));
    assert.equal(result.preference.security.otherSubmissionCodeMinAcceptedProblems, value);
    assert.equal(result.preference.security.allowRegister, true);
    assert.equal(setting.updatedByUserId, 9);
  }
});

test("qualified SQL scope keeps contest restrictions grouped with public practice and owned submissions", async () => {
  const { source } = groupFixture();
  for (const contestIds of [[], [endedContest.id]]) {
    const builder = source.createQueryBuilder().from("submission", "submission");
    const queries = [];
    builder.getMany = async () => {
      queries.push(builder.getQuery());
      return [];
    };
    const service = create(SubmissionService, { submissionRepository: { createQueryBuilder: () => builder } });
    await service.querySubmissions(
      null,
      endedContest.id,
      null,
      null,
      null,
      null,
      null,
      null,
      false,
      20,
      false,
      [outsider.id],
      contestIds
    );
    assert.match(
      queries[0],
      /WHERE \(submitterId IN .* OR \(contestId IS NULL AND isPublic = true\).*\) AND contestId = :contestId/
    );
    assert.deepEqual(builder.getParameters().allowedSubmitterIds, [outsider.id]);
    if (contestIds.length) {
      assert.match(queries[0], /OR contestId IN \(:\.\.\.otherSubmissionContestIds\)/);
      assert.deepEqual(builder.getParameters().otherSubmissionContestIds, contestIds);
    } else assert.doesNotMatch(queries[0], /otherSubmissionContestIds/);
  }
});

test("submission scope applies before pagination and is retained in pagination existence queries", async () => {
  const { source } = groupFixture();
  const builder = source.createQueryBuilder().from("submission", "submission");
  const sql = [];
  builder.getMany = async () => {
    sql.push(builder.getQuery());
    return [{ id: 100 }, { id: 90 }];
  };
  const originalClone = builder.clone.bind(builder);
  builder.clone = () => {
    const clone = originalClone();
    clone.getRawOne = async () => {
      sql.push(clone.getQuery());
      return null;
    };
    clone.clone = () => {
      const copy = originalClone();
      copy.getRawOne = async () => {
        sql.push(copy.getQuery());
        return null;
      };
      return copy;
    };
    return clone;
  };
  const service = create(SubmissionService, { submissionRepository: { createQueryBuilder: () => builder } });
  await service.querySubmissions(null, null, null, null, null, null, null, null, false, 20, false, [
    teacher.id,
    member.id
  ]);
  assert.equal(sql.length, 3);
  sql.forEach(query => assert.match(query, /submitterId IN \(:\.\.\.allowedSubmitterIds\)/));
  assert.deepEqual(builder.getParameters().allowedSubmitterIds, [teacher.id, member.id]);
});

test("group admins are exempt from contest access restrictions while ordinary members remain restricted", async () => {
  const { contestService } = fixture();
  assert.deepEqual(await contestService.getContestAccessRestriction(teacher), []);
  assert.deepEqual(await contestService.getContestAccessRestriction(member), [runningContest]);
  const guard = new ContestAccessGuard(contestService);
  const context = user => ({
    switchToHttp: () => ({ getRequest: () => ({ session: { user }, path: "/api/group/addMember" }) })
  });
  assert.equal(await guard.canActivate(context(teacher)), true);
  assert.equal(await guard.canActivate(context(member)), false);
});

test("group admins can view running NOI/IOI ranklists and grades without contest edit permissions", async () => {
  const { contestService } = fixture();
  for (const type of ["noi", "ioi", "acm"]) {
    const contest = { ...runningContest, type };
    assert.equal(await contestService.userHasPermission(teacher, contest, ContestPermissionType.ViewRanklist), true);
    assert.equal(await contestService.userHasPermission(teacher, contest, ContestPermissionType.ViewStatistics), true);
    assert.equal(await contestService.userHasPermission(teacher, contest, ContestPermissionType.Manage), false);
  }
  assert.equal(await contestService.userHasPermission(teacher, null, ContestPermissionType.Create), false);
  assert.equal(await contestService.shouldHideNoiResult(teacher, runningContest), false);
  assert.equal(await contestService.shouldHideNoiResult(member, runningContest), true);
  assert.equal(
    await contestService.userHasPermission(member, runningContest, ContestPermissionType.ViewRanklist),
    false
  );
  assert.equal(
    await contestService.userHasPermission(
      teacher,
      { ...runningContest, groupId: 12 },
      ContestPermissionType.ViewRanklist
    ),
    false
  );
  assert.equal(
    await contestService.userHasPermission(teacher, { ...runningContest, isPublic: false }, ContestPermissionType.View),
    false
  );
  assert.equal(
    await contestService.userHasPermission(
      teacher,
      { ...runningContest, startTime: new Date(Date.now() + 30000) },
      ContestPermissionType.ViewRanklist
    ),
    false
  );
});

test("live contest ranklists do not expose outsiders' grades to group admins", async () => {
  const { contestService } = fixture();
  Object.assign(contestService, {
    contestPlayerRepository: {
      findBy: async () =>
        [member, outsider].map(user => ({
          userId: user.id,
          score: 65,
          timeSpent: 1,
          scoreDetails: { [problem.id]: { score: 65 } }
        }))
    },
    userService: { findUserById: async id => users.find(user => user.id === id), getUserMeta: async user => user }
  });
  const rows = await contestService.getRanklistRows(runningContest, teacher);
  assert.deepEqual(
    rows.map(row => row.user.id),
    [member.id]
  );
  assert.equal(rows[0].score, 65);
});

function sectionFixture() {
  const { service: groupService } = groupFixture();
  const source = new DataSource({ type: "mysql", database: "test" });
  const service = create(SectionService, {
    sectionRepository: { findOneBy: async () => ({ id: 40, problems: [{ problemId: problem.id }] }) },
    groupService,
    userPrivilegeService: { userHasPrivilege: async user => !!user.isAdmin },
    userService: {
      findUsersByExistingIds: async ids => ids.map(id => users.find(user => user.id === id)),
      getUserMeta: async user => user
    },
    submissionRepository: {
      createQueryBuilder(alias) {
        const builder = source.createQueryBuilder().from("submission", alias);
        builder.getRawMany = async () => [
          {
            submissionId: String(submission.id),
            userId: String(member.id),
            problemId: String(problem.id),
            status: "Accepted"
          }
        ];
        return builder;
      }
    }
  });
  return service;
}

test("training ranklists permit managed group selection and link member submissions", async () => {
  const service = sectionFixture();
  const result = await service.querySectionGroupRanklist(teacher, { sectionId: 40, groupId: 10 });
  assert.deepEqual(
    result.groups.map(group => group.id),
    [10]
  );
  assert.equal(result.result[0].user.id, member.id);
  assert.equal(result.result[0].submissions[0].canView, true);
  const combined = await service.querySectionGroupRanklist(teacher, { sectionId: 40 });
  assert.deepEqual(
    combined.groups.map(group => group.id),
    [10, 11]
  );
  assert.deepEqual(
    combined.result.map(item => item.user.id),
    [member.id]
  );
});

test("training group selection rejects unmanaged groups and ordinary members", async () => {
  const service = sectionFixture();
  await assert.rejects(service.querySectionGroupRanklist(teacher, { sectionId: 40, groupId: 12 }), /permission denied/);
  await assert.rejects(service.querySectionGroupRanklist(member, { sectionId: 40, groupId: 10 }), /permission denied/);
  await assert.rejects(service.querySectionGroupRanklist(null, { sectionId: 40, groupId: 10 }), /permission denied/);
  const ordinary = await service.querySectionGroupRanklist(outsider, { sectionId: 40 });
  assert.equal(ordinary.result.find(item => item.user.id === member.id)?.submissions[0].canView ?? false, false);
});
