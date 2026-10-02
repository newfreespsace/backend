const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");

require("reflect-metadata");
require("tsconfig-paths").register({ baseUrl: path.resolve(__dirname, "../dist"), paths: { "@/*": ["*"] } });

const { DataSource } = require("typeorm");
const { DiscussionService, DiscussionPermissionType } = require("../dist/discussion/discussion.service");

const user = { id: 1 };
const discussion = { id: 10, problemId: 20, publisherId: 2, isPublic: true };

function fixture({ privilege = false, permission = 0, problemVisible = true } = {}) {
  return Object.assign(Object.create(DiscussionService.prototype), {
    userPrivilegeService: { userHasPrivilege: async () => privilege },
    permissionService: {
      userOrItsGroupsHavePermission: async (_user, _id, _type, level) => permission >= level,
      getUserOrItsGroupsMaxPermissionLevel: async () => permission
    },
    problemService: {
      findProblemById: async id => ({ id }),
      userHasPermission: async () => problemVisible
    },
    submissionService: { getUserProblemAcceptedSubmissionCount: async () => 0 },
    configService: { config: { preference: { security: { allowEveryoneCreateDiscussion: true } } } }
  });
}

for (const viewer of [user, null]) {
  test(`public problem discussions are readable without an accepted submission (${
    viewer ? "user" : "guest"
  })`, async () => {
    const service = fixture();
    assert.equal(await service.userHasPermission(viewer, discussion, DiscussionPermissionType.View), true);
    assert.deepEqual(await service.getUserPermissionsOfDiscussion(viewer, discussion), [DiscussionPermissionType.View]);
  });
}

test("non-public discussions still require ownership, management privilege or read permission", async () => {
  const privateDiscussion = { ...discussion, isPublic: false };
  for (const viewer of [user, null]) {
    const service = fixture();
    assert.equal(await service.userHasPermission(viewer, privateDiscussion, DiscussionPermissionType.View), false);
    assert.deepEqual(await service.getUserPermissionsOfDiscussion(viewer, privateDiscussion), []);
  }

  for (const [service, viewer] of [
    [fixture(), { id: discussion.publisherId }],
    [fixture({ privilege: true }), user],
    [fixture({ permission: 1 }), user]
  ]) {
    assert.equal(await service.userHasPermission(viewer, privateDiscussion, DiscussionPermissionType.View), true);
    assert.ok((await service.getUserPermissionsOfDiscussion(viewer, privateDiscussion)).includes("View"));
  }

  assert.equal(
    await fixture({ permission: 1, problemVisible: false }).userHasPermission(
      user,
      privateDiscussion,
      DiscussionPermissionType.View
    ),
    false
  );
});

test("viewing a discussion does not grant edit or publish permission", async () => {
  const service = fixture();
  assert.equal(await service.userHasPermission(user, discussion, DiscussionPermissionType.Modify), false);
  assert.equal(await service.userHasCreateDiscussionPermission(user, false, discussion.problemId), false);
  assert.equal(await service.userHasCreateDiscussionPermission(null), false);
});

for (const viewer of [user, null]) {
  test(`discussion list queries do not filter by accepted submissions (${viewer ? "user" : "guest"})`, async () => {
    // Build real TypeORM SQL without opening a database connection.
    const source = new DataSource({ type: "mysql", database: "test" });
    for (const problemId of [discussion.problemId, -1]) {
      const service = fixture();
      const builder = source.createQueryBuilder().from("discussion", "discussion");
      builder.getCount = async () => 1;
      builder.getRawMany = async () => [{ id: discussion.id }];
      service.discussionRepository = { createQueryBuilder: () => builder };
      service.findDiscussionsByExistingIds = async ids => ids.map(id => ({ ...discussion, id }));

      assert.deepEqual(await service.queryDiscussionsAndCount(viewer, false, null, problemId, null, false, 0, 20), [
        [discussion],
        1
      ]);
      const sql = builder.getQuery();
      assert.doesNotMatch(sql, /submission|acceptedStatus|discussion\.problemId IS NULL/i);
      assert.match(sql, /discussion\.isPublic = 1/);
      if (viewer) assert.match(sql, /discussion\.publisherId = :publisherId/);
      assert.match(sql, problemId === -1 ? /discussion\.problemId IS NOT NULL/ : /discussion\.problemId = :problemId/);
    }
  });
}
