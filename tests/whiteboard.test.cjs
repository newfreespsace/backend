const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
require("reflect-metadata");
require("tsconfig-paths").register({ baseUrl: path.resolve(__dirname, "../dist"), paths: { "@/*": ["*"] } });
const { plainToInstance } = require("class-transformer");
const { validate } = require("class-validator");
const { WhiteboardService, validateScene, MAX_SCENE_BYTES } = require("../dist/whiteboard/whiteboard.service");
const { WhiteboardController } = require("../dist/whiteboard/whiteboard.controller");
const { SaveWhiteboardDto } = require("../dist/whiteboard/whiteboard.dto");
const id = "1c5733cc-421a-4b18-b19d-70b911a64aa3";
const scene = JSON.stringify({
  type: "excalidraw",
  version: 2,
  elements: [{ id: "image", type: "image", fileId: "f" }],
  appState: { viewBackgroundColor: "#fff" },
  files: { f: { dataURL: "data:image/png;base64,aGVsbG8=", mimeType: "image/png" } }
});
function fixture() {
  const rows = new Map();
  const matches = (row, where) => row && Object.entries(where).every(([key, value]) => row[key] === value);
  const repo = {
    insert: async value => {
      if (rows.has(value.id)) throw Object.assign(new Error("duplicate"), { code: "ER_DUP_ENTRY" });
      rows.set(value.id, { ...value });
    },
    update: async (where, value) => {
      const row = rows.get(where.id);
      if (!matches(row, where)) return { affected: 0 };
      Object.assign(row, value);
      return { affected: 1 };
    },
    delete: async where => {
      if (!matches(rows.get(where.id), where)) return { affected: 0 };
      rows.delete(where.id);
      return { affected: 1 };
    },
    find: async ({ where }) => [...rows.values()].filter(r => matches(r, where)).map(({ scene, ...meta }) => meta),
    createQueryBuilder: () => {
      let where;
      return {
        addSelect() {
          return this;
        },
        where(sql, values) {
          where = values;
          return this;
        },
        async getOne() {
          const row = rows.get(where.id);
          return matches(row, where) ? { ...row } : null;
        }
      };
    }
  };
  return { service: new WhiteboardService(repo), rows };
}
const save = (version = 0) => ({ id, title: "我的画板", version, scene });
const status = code => error => error.getStatus() === code;

test("round-trips images; lists metadata only", async () => {
  const { service } = fixture();
  assert.equal((await service.save(1, save())).version, 1);
  assert.equal((await service.get(1, id)).scene, scene);
  assert.equal((await service.list(1))[0].scene, undefined);
});
test("other users cannot read, overwrite, create over or delete", async () => {
  const { service } = fixture();
  await service.save(1, save());
  assert.deepEqual(await service.list(2), []);
  await assert.rejects(service.get(2, id), status(404));
  await assert.rejects(service.save(2, save(1)), status(409));
  await assert.rejects(service.save(2, save(0)), status(409));
  await assert.rejects(service.delete(2, { id, version: 1 }), status(409));
  assert.equal((await service.get(1, id)).version, 1);
});
test("concurrent saves accept only one writer per version", async () => {
  const { service } = fixture();
  await service.save(1, save());
  const results = await Promise.allSettled([
    service.save(1, { ...save(1), title: "A" }),
    service.save(1, { ...save(1), title: "B" })
  ]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.find(r => r.status === "rejected").reason.getStatus(), 409);
  assert.equal((await service.get(1, id)).version, 2);
});
test("stale delete/save cannot silently overwrite or recreate", async () => {
  const { service } = fixture();
  await service.save(1, save());
  await service.save(1, save(1));
  await assert.rejects(service.delete(1, { id, version: 1 }), status(409));
  await service.delete(1, { id, version: 2 });
  await assert.rejects(service.save(1, save(2)), status(409));
});
test("invalid/oversized UTF-8 scenes and blank titles fail before write", async () => {
  const { service, rows } = fixture();
  for (const value of ["not json", "null", '{"type":"excalidraw","elements":[]}'])
    assert.throws(() => validateScene(value), status(400));
  assert.throws(() => validateScene("中".repeat(Math.ceil(MAX_SCENE_BYTES / 3))), status(413));
  await assert.rejects(service.save(1, { ...save(), title: "  " }), status(400));
  assert.equal(rows.size, 0);
});
test("DTO validates UUID, revision, title and string payload", async () => {
  assert.equal((await validate(plainToInstance(SaveWhiteboardDto, save()))).length, 0);
  for (const value of [{ id: "bad" }, { version: -1 }, { version: 1.5 }, { title: "a".repeat(121) }, { scene: {} }])
    assert.ok((await validate(plainToInstance(SaveWhiteboardDto, { ...save(), ...value }))).length);
});
test("controller rejects anonymous access to every operation", () => {
  const controller = new WhiteboardController({});
  for (const call of [
    () => controller.list(null),
    () => controller.get(null, { id }),
    () => controller.save(null, save()),
    () => controller.delete(null, { id, version: 1 })
  ])
    assert.throws(call, status(403));
});

test("lost responses can be retried without creating duplicates or incrementing twice", async () => {
  const { service } = fixture();
  await service.save(1, save());
  assert.equal((await service.save(1, save())).version, 1);
  await service.save(1, save(1));
  assert.equal((await service.save(1, save(1))).version, 2);
  await assert.rejects(service.save(1, { ...save(1), title: "different" }), status(409));
});
