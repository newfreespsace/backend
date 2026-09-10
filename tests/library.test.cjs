const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
require("reflect-metadata");
require("tsconfig-paths").register({ baseUrl: path.resolve(__dirname, "../dist"), paths: { "@/*": ["*"] } });
const {
  WhiteboardLibraryService,
  parseLibraryChanges,
  MAX_LIBRARY_BYTES
} = require("../dist/whiteboard/library.service");
const { WhiteboardController } = require("../dist/whiteboard/whiteboard.controller");
const { SaveLibraryDto } = require("../dist/whiteboard/whiteboard.dto");
const { validate } = require("class-validator");
const { plainToInstance } = require("class-transformer");
const item = id => ({ id, status: "published", created: 1, elements: [{ id: `element-${id}`, type: "rectangle" }] });
const add = id => ({ id, item: item(id) });
function fixture() {
  const rows = new Map();
  const repo = {
    findOneBy: async ({ userId }) => (rows.has(userId) ? { ...rows.get(userId) } : null),
    insert: async row => {
      if (rows.has(row.userId)) throw Object.assign(new Error(), { code: "ER_DUP_ENTRY" });
      rows.set(row.userId, { ...row });
    },
    update: async ({ userId, version }, next) => {
      const row = rows.get(userId);
      if (row?.version !== version) return { affected: 0 };
      Object.assign(row, next);
      return { affected: 1 };
    }
  };
  return { service: new WhiteboardLibraryService(repo), rows };
}
const status = code => error => error.getStatus() === code;
test("library is account-wide and each account can only address its own data", async () => {
  const { service } = fixture();
  await service.save(1, JSON.stringify([add("中文素材")]));
  assert.deepEqual(await service.get(1), { libraryItems: [item("中文素材")] });
  assert.deepEqual(await service.get(2), { libraryItems: [] });
  await service.save(2, JSON.stringify([{ id: "中文素材" }]));
  assert.equal((await service.get(1)).libraryItems.length, 1);
});
test("concurrent first creation and later edits merge without losing unrelated items", async () => {
  const { service } = fixture();
  await Promise.all([service.save(1, JSON.stringify([add("A")])), service.save(1, JSON.stringify([add("B")]))]);
  await Promise.all([service.save(1, JSON.stringify([{ id: "A" }])), service.save(1, JSON.stringify([add("C")]))]);
  assert.deepEqual((await service.get(1)).libraryItems.map(x => x.id).sort(), ["B", "C"]);
});
test("duplicate import and exact retries do not duplicate items or increment versions", async () => {
  const { service, rows } = fixture();
  await service.save(1, JSON.stringify([add("A")]));
  await service.save(1, JSON.stringify([add("A")]));
  assert.equal(rows.get(1).version, 1);
  await service.save(1, JSON.stringify([{ id: "A" }]));
  await service.save(1, JSON.stringify([{ id: "A" }]));
  assert.equal(rows.get(1).version, 2);
});
test("malformed and oversized changes fail; merged library size is also bounded", async () => {
  const { service, rows } = fixture();
  for (const value of [
    "null",
    "{}",
    "invalid",
    '[{"id":1}]',
    JSON.stringify([{ id: "A", item: item("B") }]),
    JSON.stringify([{ id: "A", item: { ...item("A"), elements: [] } }])
  ])
    assert.throws(() => parseLibraryChanges(value), status(400));
  assert.throws(() => parseLibraryChanges("中".repeat(MAX_LIBRARY_BYTES / 3 + 1)), status(413));
  const large = id => ({ id, item: { ...item(id), padding: "x".repeat(MAX_LIBRARY_BYTES / 2) } });
  await service.save(1, JSON.stringify([large("A")]));
  await assert.rejects(service.save(1, JSON.stringify([large("B")])), status(413));
  assert.equal(rows.get(1).version, 1);
});
test("library controller rejects anonymous users and uses authenticated identity", async () => {
  const { service } = fixture();
  const controller = new WhiteboardController(null, service);
  assert.throws(() => controller.getLibrary(null), status(403));
  assert.throws(() => controller.saveLibrary(null, { changes: "[]" }), status(403));
  await controller.saveLibrary({ id: 1 }, { userId: 2, changes: JSON.stringify([add("A")]) });
  assert.deepEqual((await controller.getLibrary({ id: 2 })).libraryItems, []);
  assert.equal((await validate(plainToInstance(SaveLibraryDto, { changes: [] }))).length, 1);
});
