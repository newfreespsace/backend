const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const { randomUUID, createECDH, randomBytes } = require("node:crypto");
require("reflect-metadata");
require("tsconfig-paths").register({ baseUrl: path.resolve(__dirname, "../dist"), paths: { "@/*": ["*"] } });
const { plainToInstance } = require("class-transformer");
const { validate } = require("class-validator");
const { DataSource } = require("typeorm");
const E = require("../dist/notification/notification.entity");
const {
  NotificationEntity: N,
  NotificationRecipientEntity: R,
  PushSubscriptionEntity: S,
  NotificationPushJobEntity: J
} = E;
const { NotificationService } = require("../dist/notification/notification.service");
const { NotificationPushService } = require("../dist/notification/notification-push.service");
const { NotificationController } = require("../dist/notification/notification.controller");
const { NotificationGateway } = require("../dist/notification/notification.gateway");
const { AuthSessionService } = require("../dist/auth/auth-session.service");
const { UserEntity: U } = require("../dist/user/user.entity");
const { GroupEntity: G } = require("../dist/group/group.entity");
const { GroupMembershipEntity: M } = require("../dist/group/group-membership.entity");
const { SendNotificationDto, BindPushDto, QueryNotificationsDto } = require("../dist/notification/notification.dto");
const {
  validateNotificationPath,
  validatePushEndpoint,
  validatePushKeys
} = require("../dist/notification/notification-security");
const webPush = require("web-push");
const admin = { id: 1, username: "admin", isAdmin: true, isActive: true };
function keys() {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  return { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") };
}
function matches(row, where) {
  return Object.entries(where).every(([key, value]) => {
    if (value && typeof value === "object" && value._type) {
      if (value._type === "isNull") return row[key] == null;
      if (value._type === "in") return value._value.includes(row[key]);
      if (value._type === "moreThan") return row[key] > value._value;
      if (value._type === "not") return row[key] !== value._value;
      throw new Error(`Unexpected operator ${value._type}`);
    }
    return value instanceof Date ? +row[key] === +value : row[key] === value;
  });
}
function fixture() {
  const rows = new Map([
    [
      U,
      [
        admin,
        { id: 2, username: "alice", isActive: true },
        { id: 3, username: "bob", isActive: true },
        { id: 4, username: "disabled", isActive: false }
      ]
    ],
    [G, [{ id: 10 }]],
    [M, [{ groupId: 10, userId: 2 }]],
    ...Object.values(E).map(entity => [entity, []])
  ]);
  const published = [],
    repositories = new Map();
  const repo = entity => {
    if (repositories.has(entity)) return repositories.get(entity);
    const repository = {
      create: data => ({ ...data }),
      insert: async values => {
        for (const value of [values].flat()) {
          const row = {
            ...value,
            id: value.id || (entity === S || entity === N ? randomUUID() : rows.get(entity).length + 1)
          };
          if (
            rows
              .get(entity)
              .some(item => item.id === row.id || (entity === S && item.endpointHash === row.endpointHash))
          )
            throw new Error("duplicate");
          rows.get(entity).push(row);
        }
      },
      save: async value => {
        const row = rows.get(entity).find(item => item.id === value.id);
        if (row) Object.assign(row, value);
        else await repository.insert(value);
        return rows
          .get(entity)
          .find(item => item.id === value.id || (entity === S && item.endpointHash === value.endpointHash));
      },
      findOneBy: async where => rows.get(entity).find(row => matches(row, where)) || null,
      findOne: async options => {
        const row = await repository.findOneBy(options.where);
        return row && options.relations
          ? { ...row, notification: rows.get(N).find(item => item.id === row.notificationId) }
          : row;
      },
      findBy: async where => rows.get(entity).filter(row => matches(row, where)),
      find: async options => repository.findBy(options.where),
      findAndCount: async options => {
        const selected = rows
          .get(entity)
          .filter(row => !options.where || matches(row, options.where))
          .sort((a, b) => b.id - a.id);
        return [
          selected
            .slice(options.skip || 0, (options.skip || 0) + options.take)
            .map(row =>
              options.relations
                ? { ...row, notification: rows.get(N).find(item => item.id === row.notificationId) }
                : row
            ),
          selected.length
        ];
      },
      countBy: async where => rows.get(entity).filter(row => matches(row, where)).length,
      update: async (where, values) => {
        const selected = rows.get(entity).filter(row => matches(row, where));
        selected.forEach(row => Object.assign(row, values));
        return { affected: selected.length };
      },
      createQueryBuilder: () => {
        const parameters = {};
        return {
          select() {
            return this;
          },
          where(_sql, params) {
            Object.assign(parameters, params);
            return this;
          },
          andWhere(_sql, params) {
            Object.assign(parameters, params);
            return this;
          },
          innerJoin(_entity, _alias, _sql, params) {
            Object.assign(parameters, params);
            return this;
          },
          getRawMany: async () =>
            rows
              .get(U)
              .filter(
                user =>
                  user.isActive &&
                  (!parameters.usernames || parameters.usernames.includes(user.username)) &&
                  (!parameters.groupId ||
                    rows.get(M).some(member => member.groupId === parameters.groupId && member.userId === user.id))
              )
              .map(user => ({ id: user.id }))
        };
      }
    };
    repositories.set(entity, repository);
    return repository;
  };
  const dataSource = {
    transaction: async callback => {
      const snapshot = structuredClone([...rows.values()]);
      try {
        return await callback({ getRepository: repo });
      } catch (error) {
        [...rows.keys()].forEach((entity, index) => rows.set(entity, snapshot[index]));
        throw error;
      }
    }
  };
  const service = new NotificationService(
    dataSource,
    repo(N),
    repo(R),
    repo(S),
    { getSharedClient: () => ({ publish: async (_channel, data) => published.push(JSON.parse(data)) }) },
    { enabled: true, publicKey: "public" }
  );
  const request = overrides =>
    plainToInstance(SendNotificationDto, {
      body: "Private content",
      audience: "users",
      usernames: ["alice"],
      requestId: randomUUID(),
      ...overrides
    });
  const worker = new NotificationPushService(repo(J), repo(S), repo(R), repo(U), { isSessionActive: async () => true });
  worker.logger = { warn() {} };
  return { rows, repo, service, published, request, worker };
}
async function preparedWorker() {
  const f = fixture();
  await f.service.bindPush(2, 10, new Date(Date.now() + 3600000), {
    endpoint: "https://fcm.googleapis.com/alice",
    keys: keys()
  });
  await f.service.send(admin, f.request({ push: true }));
  return { ...f, job: { ...f.rows.get(J)[0] } };
}

test("new entities build MySQL metadata alongside the existing entities", async () => {
  const source = new DataSource({
    type: "mariadb",
    database: "notification_test_metadata",
    entities: [path.resolve(__dirname, "../dist/**/*.entity.js")]
  });
  await source.buildMetadatas();
  for (const entity of Object.values(E)) assert.ok(source.getMetadata(entity));
  assert.ok(source.getMetadata(R).indices.some(index => index.isUnique && index.columns.length === 2));
});
test("validation rejects forged user IDs, oversized audiences and invalid pagination", async () => {
  const options = { whitelist: true, forbidNonWhitelisted: true };
  assert.ok(
    (
      await validate(
        plainToInstance(BindPushDto, { endpoint: "https://fcm.googleapis.com/x", keys: keys(), userId: 3 }),
        options
      )
    ).length
  );
  assert.ok((await validate(plainToInstance(QueryNotificationsDto, { take: 1000 }), options)).length);
  const f = fixture();
  assert.equal((await validate(f.request(), options)).length, 0);
  assert.ok((await validate(f.request({ usernames: Array.from({ length: 501 }, (_, i) => `u${i}`) }), options)).length);
});

test("notifications accept body-only content and reject missing or whitespace-only bodies", async () => {
  const f = fixture();
  const options = { whitelist: true, forbidNonWhitelisted: true };
  assert.equal((await validate(f.request(), options)).length, 0);
  assert.ok((await validate(f.request({ body: undefined }), options)).length);
  assert.ok((await validate(f.request({ body: "" }), options)).length);
  await assert.rejects(() => f.service.send(admin, f.request({ body: " \n " })));
  assert.equal(f.rows.get(N).length, 0);
  const result = await f.service.send(admin, f.request({ body: "  Body without a title  " }));
  assert.equal((await f.service.get(2, result.id)).item.body, "Body without a title");
});

test("legacy notifications retain their body without exposing a title in any notification API", async () => {
  const f = fixture();
  const result = await f.service.send(admin, f.request());
  f.rows.get(N)[0].title = "Legacy title";
  const detail = (await f.service.get(2, result.id)).item;
  const list = (await f.service.query(2, { skip: 0, take: 20 })).items[0];
  const history = (await f.service.history({ skip: 0, take: 20 })).items[0];
  for (const item of [detail, list, history]) {
    assert.equal(item.body, "Private content");
    assert.equal(Object.hasOwn(item, "title"), false);
  }
});
test("external and encoded redirect paths and untrusted push providers are rejected", () => {
  for (const link of [
    "https://evil.test",
    "//evil.test",
    "/\\evil.test",
    "/%2fevil.test",
    "/%252fevil.test",
    "/%5cevil.test",
    "/x\n"
  ])
    assert.throws(() => validateNotificationPath(link));
  assert.equal(validateNotificationPath("/c/123?tab=ranklist"), "/c/123?tab=ranklist");
  for (const endpoint of [
    "http://fcm.googleapis.com/x",
    "https://127.0.0.1/x",
    "https://fcm.googleapis.com.evil.test/x",
    "https://fcm.googleapis.com:8080/x",
    "https://user:pass@fcm.googleapis.com/x"
  ])
    assert.throws(() => validatePushEndpoint(endpoint));
  for (const endpoint of [
    "https://fcm.googleapis.com/fcm/send/x",
    "https://updates.push.services.mozilla.com/wpush/v2/x",
    "https://web.push.apple.com/x",
    "https://wns2-test.notify.windows.com/w/?token=test"
  ])
    validatePushEndpoint(endpoint);
  validatePushKeys(keys());
  assert.throws(() => validatePushKeys({ p256dh: "x", auth: "x" }));
});
test("admin-only sends, private retrieval and read state are scoped to recipients", async () => {
  const f = fixture();
  await assert.rejects(() => f.service.send({ id: 2, isAdmin: false }, f.request()));
  const result = await f.service.send(admin, f.request());
  assert.equal(result.recipientCount, 1);
  assert.deepEqual(
    f.rows.get(R).map(row => row.userId),
    [2]
  );
  assert.deepEqual(f.published, [{ userIds: [2] }]);
  assert.equal((await f.service.query(3, { skip: 0, take: 20 })).total, 0);
  await assert.rejects(() => f.service.get(3, result.id));
  await f.service.markRead(3, result.id);
  assert.equal((await f.service.unreadCount(2)).count, 1);
  assert.equal((await f.service.get(2, result.id)).item.body, "Private content");
  await f.service.markRead(2, result.id);
  assert.equal((await f.service.unreadCount(2)).count, 0);
});
test("all/group audiences snapshot active accounts; unknown recipients roll back", async () => {
  const all = fixture();
  await all.service.send(admin, all.request({ audience: "all", usernames: [] }));
  assert.deepEqual(
    all.rows.get(R).map(row => row.userId),
    [1, 2, 3]
  );
  const group = fixture();
  await group.service.send(admin, group.request({ audience: "group", usernames: [], groupId: 10 }));
  assert.deepEqual(
    group.rows.get(R).map(row => row.userId),
    [2]
  );
  for (const usernames of [["unknown"], ["disabled"], ["alice", "unknown"]]) {
    const f = fixture();
    await assert.rejects(() => f.service.send(admin, f.request({ usernames })));
    assert.equal(f.rows.get(N).length, 0);
  }
});
test("send retries are idempotent, reject content conflicts and roll back failed fanout", async () => {
  const f = fixture(),
    request = f.request();
  assert.deepEqual(await f.service.send(admin, request), await f.service.send(admin, request));
  assert.equal(f.rows.get(N).length, 1);
  assert.equal(f.rows.get(R).length, 1);
  await assert.rejects(() => f.service.send(admin, { ...request, body: "changed" }));
  const broken = fixture();
  broken.repo(R).insert = async () => {
    throw new Error("database unavailable");
  };
  await assert.rejects(() => broken.service.send(admin, broken.request()));
  assert.equal(broken.rows.get(N).length, 0);
  assert.equal(broken.published.length, 0);
});
test("subscriptions cannot transfer accounts; session changes rotate the binding and disable is owner-scoped", async () => {
  const f = fixture(),
    payload = { endpoint: "https://fcm.googleapis.com/test", keys: keys() },
    expires = new Date(Date.now() + 3600000);
  const binding = await f.service.bindPush(2, 10, expires, payload);
  assert.equal(binding.userId, 2);
  assert.equal((await f.service.bindPush(2, 10, expires, payload)).bindingVersion, binding.bindingVersion);
  await assert.rejects(() => f.service.bindPush(3, 11, expires, payload));
  await f.service.disablePush(3, binding.id);
  assert.equal(f.rows.get(S)[0].enabled, true);
  assert.notEqual((await f.service.bindPush(2, 11, expires, payload)).bindingVersion, binding.bindingVersion);
  await f.service.disablePush(2, binding.id);
  assert.equal(f.rows.get(S)[0].enabled, false);
});
test("push jobs snapshot only enabled devices belonging to the targeted user", async () => {
  const f = fixture(),
    expires = new Date(Date.now() + 3600000);
  await f.service.bindPush(2, 10, expires, { endpoint: "https://fcm.googleapis.com/alice-1", keys: keys() });
  await f.service.bindPush(2, 10, expires, { endpoint: "https://web.push.apple.com/alice-2", keys: keys() });
  await f.service.bindPush(3, 11, expires, { endpoint: "https://fcm.googleapis.com/bob", keys: keys() });
  await f.service.send(admin, f.request({ push: true }));
  assert.equal(f.rows.get(J).length, 2);
  assert.ok(f.rows.get(J).every(job => job.userId === 2));
});
test("worker rechecks session, account, recipient and binding; encrypted payload omits content", async t => {
  const original = webPush.sendNotification,
    calls = [];
  t.after(() => {
    webPush.sendNotification = original;
  });
  webPush.sendNotification = async (...args) => {
    calls.push(args);
  };
  const valid = await preparedWorker();
  await valid.worker.deliver(valid.job);
  assert.equal(valid.rows.get(J)[0].status, "sent");
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].endpoint, "https://fcm.googleapis.com/alice");
  assert.deepEqual(Object.keys(JSON.parse(calls[0][1])).sort(), ["bindingVersion", "notificationId", "userId"]);
  for (const invalidate of [
    f => {
      f.rows.get(S)[0].enabled = false;
    },
    f => {
      f.rows.get(S)[0].bindingVersion = randomUUID();
    },
    f => {
      f.rows.get(S)[0].userId = 3;
    },
    f => {
      f.rows.get(U).find(user => user.id === 2).isActive = false;
    },
    f => {
      f.rows.get(R)[0].readAt = new Date();
    },
    f => {
      f.worker.sessions = { isSessionActive: async () => false };
    }
  ]) {
    const f = await preparedWorker();
    invalidate(f);
    await f.worker.deliver(f.job);
    assert.equal(f.rows.get(J)[0].status, "cancelled");
  }
  assert.equal(calls.length, 1);
});
test("queue retries temporary errors, disables expired endpoints and claims each job once", async t => {
  const original = webPush.sendNotification;
  t.after(() => {
    webPush.sendNotification = original;
  });
  const retry = await preparedWorker();
  webPush.sendNotification = async () => {
    throw { statusCode: 503 };
  };
  await retry.worker.deliver(retry.job);
  assert.equal(retry.rows.get(J)[0].status, "pending");
  assert.equal(retry.rows.get(J)[0].attempts, 1);
  const expired = await preparedWorker();
  webPush.sendNotification = async () => {
    throw { statusCode: 410 };
  };
  await expired.worker.deliver(expired.job);
  assert.equal(expired.rows.get(J)[0].status, "expired");
  assert.equal(expired.rows.get(S)[0].enabled, false);
  const concurrent = await preparedWorker();
  let count = 0;
  webPush.sendNotification = async () => {
    count++;
  };
  await Promise.all([concurrent.worker.deliver(concurrent.job), concurrent.worker.deliver(concurrent.job)]);
  assert.equal(count, 1);
});
test("logout disables session subscriptions and disconnects realtime clients; errors are not swallowed", async () => {
  const f = fixture();
  await f.service.bindPush(2, 10, new Date(Date.now() + 3600000), {
    endpoint: "https://fcm.googleapis.com/alice",
    keys: keys()
  });
  const service = Object.create(AuthSessionService.prototype),
    events = [];
  service.pushSubscriptions = f.repo(S);
  service.redis = { callSessionManager: async () => {} };
  service.redisService = {
    getSharedClient: () => ({ publish: async (_channel, data) => events.push(JSON.parse(data)) })
  };
  await service.revokeSession(2, 10);
  assert.equal(f.rows.get(S)[0].enabled, false);
  assert.deepEqual(events, [{ revoke: { userId: 2, sessionId: 10 } }]);
  service.decodeSessionKey = () => [2, 10];
  service.revokeSession = async () => {
    throw new Error("unavailable");
  };
  await assert.rejects(() => service.endSession("valid-token"), /unavailable/);
});
test("realtime uses validated bearer identity and joins only that user's room", async () => {
  let middleware, onMessage;
  const emitted = [];
  const server = {
    use(callback) {
      middleware = callback;
    },
    to(room) {
      return { emit: event => emitted.push([room, event]) };
    },
    emit() {}
  };
  const subscriber = {
    on(event, callback) {
      if (event === "message") onMessage = callback;
    },
    subscribe: async () => {},
    disconnect() {}
  };
  const gateway = new NotificationGateway(
    { accessSession: async token => (token === "valid" ? [10, { id: 2 }] : [null, null]) },
    { getClient: () => subscriber }
  );
  gateway.afterInit(server);
  let rejected;
  await middleware({ handshake: { auth: { userId: 3 } } }, error => {
    rejected = error;
  });
  assert.ok(rejected);
  const rooms = [],
    socket = {
      id: "socket",
      data: {},
      handshake: { auth: { token: "valid", userId: 3 } },
      join: room => rooms.push(room),
      emit() {},
      disconnect() {}
    };
  await middleware(socket, error => assert.equal(error, undefined));
  gateway.handleConnection(socket);
  assert.deepEqual(rooms, ["user:2"]);
  onMessage("nsoj:notifications", JSON.stringify({ userIds: [2] }));
  assert.deepEqual(emitted, [["user:2", "changed"]]);
  gateway.handleDisconnect(socket);
  await gateway.onModuleDestroy();
});
test("controller denies non-admin history and takes binding identity from the session", () => {
  let received;
  const controller = new NotificationController({
    bindPush: (...args) => {
      received = args;
      return {};
    }
  });
  assert.throws(() => controller.history({ id: 2, isActive: true, isAdmin: false }, {}));
  const token = require("jsonwebtoken").sign({ exp: Math.floor(Date.now() / 1000) + 60 }, "test-only");
  controller.bindPush(
    { id: 2, isActive: true },
    { session: { sessionKey: token, sessionId: 10 } },
    { endpoint: "test" }
  );
  assert.equal(received[0], 2);
  assert.equal(received[1], 10);
});

test("request logs redact subscription endpoints and encryption secrets without mutating the request", () => {
  const { redactRequestBody } = require("../dist/common/redact-request-body");
  const original = { endpoint: "https://fcm.googleapis.com/private-capability", keys: keys() };
  const safe = redactRequestBody(original);
  assert.deepEqual(safe, { endpoint: "[REDACTED]", keys: { p256dh: "[REDACTED]", auth: "[REDACTED]" } });
  assert.notEqual(original.keys.auth, "[REDACTED]");
});

test("notification reconnects disconnect only the notification namespace, preserving judging sockets", async () => {
  const subscriber = { on() {}, subscribe: async () => {}, disconnect() {} };
  const gateway = new NotificationGateway({}, { getClient: () => subscriber });
  const calls = [];
  gateway.handleConnection({ id: "unauthorized", data: {}, disconnect: (...args) => calls.push(args) });
  assert.deepEqual(calls, [[]]);
});
