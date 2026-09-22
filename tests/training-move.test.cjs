const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");

require("reflect-metadata");
require("tsconfig-paths").register({ baseUrl: path.resolve(__dirname, "../dist"), paths: { "@/*": ["*"] } });

const { ChapterService } = require("../dist/training/chapter.service");
const { SectionService } = require("../dist/training/section.service");
const { ChapterEntity } = require("../dist/training/entities/chapter.entity");
const { SectionEntity } = require("../dist/training/entities/section.entity");
const { TrainingEntity } = require("../dist/training/entities/training.entity");

function createFixture(initialRows) {
  const rowsByEntity = new Map(
    Object.entries(initialRows).map(([name, rows]) => [name, rows.map(row => ({ ...row }))])
  );
  const repositories = new Map();
  const entityName = entity => entity.name;
  const matches = (row, where) => Object.entries(where).every(([key, value]) => row[key] === value);

  const manager = {
    getRepository(entity) {
      const name = entityName(entity);
      if (repositories.has(name)) return repositories.get(name);
      const rows = rowsByEntity.get(name) || [];
      const repository = {
        manager,
        async findOneBy(where) {
          return rows.find(row => matches(row, where)) || null;
        },
        async find(options = {}) {
          const result = options.where ? rows.filter(row => matches(row, options.where)) : [...rows];
          const order = Object.keys(options.order || {});
          return result.sort((a, b) => {
            for (const key of order) {
              if (a[key] !== b[key]) return a[key] - b[key];
            }
            return 0;
          });
        },
        async preload(value) {
          const row = rows.find(item => item.id === value.id);
          return row ? { ...row, ...value } : undefined;
        },
        async save(value) {
          const index = rows.findIndex(row => row.id === value.id);
          if (index >= 0) rows[index] = { ...value };
          else rows.push({ ...value });
          return rows[index >= 0 ? index : rows.length - 1];
        },
        async update(id, changes) {
          const row = rows.find(item => item.id === id);
          if (row) Object.assign(row, changes);
        }
      };
      repositories.set(name, repository);
      return repository;
    },
    async transaction(callback) {
      return await callback(manager);
    }
  };

  return {
    manager,
    rows(entity) {
      return rowsByEntity.get(entityName(entity));
    }
  };
}

test("moving a chapter appends it to the target training and compacts both orderings", async () => {
  const fixture = createFixture({
    TrainingEntity: [
      { id: 1, title: "A" },
      { id: 2, title: "B" }
    ],
    ChapterEntity: [
      { id: 1, trainingId: 1, title: "Moved", sortOrder: 1 },
      { id: 2, trainingId: 1, title: "Remaining", sortOrder: 4 },
      { id: 3, trainingId: 2, title: "Target", sortOrder: 7 }
    ]
  });
  const service = new ChapterService(
    fixture.manager.getRepository(ChapterEntity),
    fixture.manager.getRepository(TrainingEntity),
    null
  );

  const result = await service.updateChapter(1, { id: 1, trainingId: 2, title: "Updated" });

  assert.equal(result.trainingId, 2);
  assert.equal(result.sortOrder, 2);
  assert.deepEqual(
    fixture.rows(ChapterEntity).map(({ id, trainingId, sortOrder }) => ({ id, trainingId, sortOrder })),
    [
      { id: 1, trainingId: 2, sortOrder: 2 },
      { id: 2, trainingId: 1, sortOrder: 1 },
      { id: 3, trainingId: 2, sortOrder: 1 }
    ]
  );
});

test("moving a section appends it to the target chapter and compacts both orderings", async () => {
  const fixture = createFixture({
    ChapterEntity: [
      { id: 10, trainingId: 1, title: "A" },
      { id: 20, trainingId: 2, title: "B" }
    ],
    SectionEntity: [
      { id: 1, chapterId: 10, title: "Moved", sortOrder: 2 },
      { id: 2, chapterId: 10, title: "Remaining", sortOrder: 5 },
      { id: 3, chapterId: 20, title: "Target", sortOrder: 9 }
    ]
  });
  const service = new SectionService(
    fixture.manager.getRepository(ChapterEntity),
    fixture.manager.getRepository(SectionEntity),
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null
  );

  const result = await service.updateSection(1, { id: 1, chapterId: 20, description: "Updated" });

  assert.equal(result.chapterId, 20);
  assert.equal(result.sortOrder, 2);
  assert.deepEqual(
    fixture.rows(SectionEntity).map(({ id, chapterId, sortOrder }) => ({ id, chapterId, sortOrder })),
    [
      { id: 1, chapterId: 20, sortOrder: 2 },
      { id: 2, chapterId: 10, sortOrder: 1 },
      { id: 3, chapterId: 20, sortOrder: 1 }
    ]
  );
});
