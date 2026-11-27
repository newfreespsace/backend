const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

require("reflect-metadata");
const yaml = require("js-yaml");

const configPath = process.env.NSOJ_HACK_TEST_CONFIG;

test("Hack writes keep inputs, solutions and review notes out of request reports", () => {
  const { redactRequestBody } = require("../dist/common/redact-request-body");
  const body = { input: "fixture", reference: { code: "fixture" }, reason: "fixture" };
  for (const route of ["create", "saveProfile", "revoke"]) {
    assert.equal(redactRequestBody(body, "/api/hack/" + route), "[REDACTED]");
  }
  assert.deepEqual(redactRequestBody({ id: 5 }, "/api/hack/history"), { id: 5 });
});

test(
  "HTTP Hack admission, judge RPC, effective results and download quota",
  { skip: !configPath, timeout: 90000 },
  async () => {
    const isolatedConfig = yaml.load(fs.readFileSync(configPath, "utf8"));
    assert.equal(isolatedConfig.services.database.database, "hack_fixture");
    assert.equal(isolatedConfig.services.database.host, "127.0.0.1");
    process.env.LYRIO_CONFIG_FILE = configPath;
    String.prototype.format = function format(...args) {
      return require("node:util").format(String(this), ...args);
    };

    const main = path.resolve(__dirname, "../dist/main.js");
    require.cache[main] = { id: main, filename: main, loaded: true, exports: { appGitRepoInfo: {} } };
    const { AppModule } = require("../dist/app.module");
    const { AuthSessionService } = require("../dist/auth/auth-session.service");
    const { ContestEntity } = require("../dist/contest/contest.entity");
    const { ContestPlayerEntity } = require("../dist/contest/contest-player.entity");
    const { FileEntity } = require("../dist/file/file.entity");
    const { FileService } = require("../dist/file/file.service");
    const { JudgeClientEntity } = require("../dist/judge/judge-client.entity");
    const { ProblemEntity } = require("../dist/problem/problem.entity");
    const { ProblemJudgeInfoEntity } = require("../dist/problem/problem-judge-info.entity");
    const { ProblemFileEntity } = require("../dist/problem/problem-file.entity");
    const { SubmissionDetailEntity } = require("../dist/submission/submission-detail.entity");
    const { SubmissionEntity } = require("../dist/submission/submission.entity");
    const { UserEntity } = require("../dist/user/user.entity");
    const { RedisService } = require("../dist/redis/redis.service");
    const { NestFactory } = require("@nestjs/core");
    const { ValidationPipe } = require("@nestjs/common");
    const { DataSource } = require("typeorm");
    const { io } = require(require.resolve("socket.io-client", { paths: [path.resolve(__dirname, "../../judge")] }));
    const parser = require("socket.io-msgpack-parser");

    const clients = new Set();
    const getClient = RedisService.prototype.getClient;
    const getSharedClient = RedisService.prototype.getSharedClient;
    for (const [name, original] of [
      ["getClient", getClient],
      ["getSharedClient", getSharedClient]
    ]) {
      RedisService.prototype[name] = function (...args) {
        const client = original.apply(this, args);
        clients.add(client);
        return client;
      };
    }
    let app;
    let socket;
    try {
      app = await NestFactory.create(AppModule, { logger: ["error", "warn"], abortOnError: false });
      app.setGlobalPrefix("api");
      app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
      await app.listen(0, "127.0.0.1");
      const endpoint = await app.getUrl();
      const db = app.get(DataSource);
      const seed = Date.now().toString(36);
      const users = db.getRepository(UserEntity);
      const givenUser = (suffix, isAdmin = false, acceptedProblemCount = 0) =>
        users.save(
          users.create({
            username: seed + suffix,
            rating: 0,
            email: `${seed}${suffix}@example.test`,
            nickname: seed + suffix,
            isAdmin,
            isActive: true,
            submissionCount: 0,
            acceptedProblemCount,
            bio: "",
            avatarInfo: "",
            publicEmail: false
          })
        );
      const manager = await givenUser("m", true);
      const author = await givenUser("a", false, 1);
      const challenger = await givenUser("c");
      const authorToken = await app.get(AuthSessionService).newSession(author, "127.0.0.1", "hack-fixture");
      const challengeToken = await app.get(AuthSessionService).newSession(challenger, "127.0.0.1", "hack-fixture");
      const managerToken = await app.get(AuthSessionService).newSession(manager, "127.0.0.1", "hack-fixture");
      const post = async (route, body, token = challengeToken) => {
        const response = await fetch(endpoint + "/api/" + route, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
          body: JSON.stringify(body)
        });
        return [response.status, await response.json()];
      };

      const problems = db.getRepository(ProblemEntity);
      const problem = await problems.save(
        problems.create({
          ownerId: manager.id,
          type: "Traditional",
          isPublic: true,
          locales: ["zh-CN"],
          submissionCount: 2,
          acceptedSubmissionCount: 2
        })
      );
      await db.getRepository(ProblemJudgeInfoEntity).save({
        problemId: problem.id,
        submittable: true,
        judgeInfo: {
          checker: { type: "binary" },
          timeLimit: 1000,
          memoryLimit: 128,
          subtasks: [],
          extraSourceFiles: { cpp: { "fixture.h": "basic.in" } }
        }
      });
      const testdataUuid = require("node:crypto").randomUUID();
      await app.get(FileService).uploadFile(testdataUuid, Buffer.from("1\n"));
      await db.getRepository(FileEntity).save({ uuid: testdataUuid, size: 2, uploadTime: new Date() });
      await db
        .getRepository(ProblemFileEntity)
        .save({ problemId: problem.id, type: "TestData", filename: "basic.in", uuid: testdataUuid });
      const now = Math.floor(Date.now() / 1000) * 1000;
      const contests = db.getRepository(ContestEntity);
      const contest = await contests.save(
        contests.create({
          title: seed,
          subtitle: "",
          information: "",
          type: "acm",
          isPublic: true,
          hideStatistics: false,
          holderId: manager.id,
          problemIds: [problem.id],
          adminIds: [],
          startTime: new Date(now - 100000),
          endTime: new Date(now - 30000)
        })
      );
      const submissionRepo = db.getRepository(SubmissionEntity);
      const newSubmission = async (user, phase) => {
        const target = await submissionRepo.save(
          submissionRepo.create({
            problemId: problem.id,
            isPublic: true,
            contestId: contest.id,
            contestProblemIndex: 1,
            contestPhase: phase,
            status: "Accepted",
            score: 100,
            timeUsed: 4,
            memoryUsed: 256,
            submitterId: user.id,
            codeLanguage: "cpp",
            submitTime: new Date(now - 90000)
          })
        );
        await db.getRepository(SubmissionDetailEntity).save({
          submissionId: target.id,
          result: { progressType: "Finished", status: "Accepted", score: 100 },
          content: { language: "cpp", code: "int main() {}", compileAndRunOptions: {} }
        });
        return target;
      };
      const target = await newSubmission(author, "official");
      const hidden = await newSubmission(manager, "official");
      const program = {
        language: "python",
        code: "import sys\nsys.exit(0)",
        compileAndRunOptions: { version: "3.10" }
      };
      const [setting, feedback] = await post(
        "hack/saveProfile",
        {
          problemId: problem.id,
          enabled: true,
          inputLimit: 1048576,
          validator: program,
          reference: program
        },
        managerToken
      );
      assert.equal(setting, 201, JSON.stringify(feedback));

      const [targetStatus, targets] = await post("hack/targets", { problemId: problem.id, contestId: contest.id });
      assert.equal(targetStatus, 201);
      assert.deepEqual(
        targets.targets.map(row => row.id),
        [target.id]
      );
      assert.deepEqual(Object.keys(targets.targets[0]).sort(), ["id", "language", "time"]);
      assert.equal((await post("hack/create", { id: hidden.id, input: "4\n" }))[0], 404);
      assert.equal((await post("hack/history", { id: target.id }))[0], 404);

      const [createdStatus, created] = await post("hack/create", { id: target.id, input: "4\n" });
      assert.equal(createdStatus, 201, JSON.stringify(created));
      assert.equal((await post("hack/create", { id: target.id, input: "4\n" }))[1].id, created.id);
      assert.equal((await post("hack/create", { id: target.id, input: "5\n" }))[1].message, "HACK_ALREADY_PENDING");

      const key = require("node:crypto").randomBytes(20).toString("hex");
      await db.getRepository(JudgeClientEntity).save({ name: seed, key, allowedHosts: [] });
      socket = io(endpoint + "/judge", {
        path: "/api/socket",
        transports: ["websocket"],
        query: { key },
        parser,
        reconnection: false
      });
      await new Promise((resolve, reject) => {
        socket.once("ready", (_name, _config, capabilities) => {
          try {
            assert.equal(capabilities.hack, 1);
            resolve();
          } catch (error) {
            reject(error);
          }
        });
        socket.once("connect_error", reject);
      });
      const rpc = (event, payload) =>
        new Promise((resolve, reject) => {
          socket.timeout(5000).emit(event, payload, (error, response) => (error ? reject(error) : resolve(response)));
        });
      assert.equal(await rpc("claimHack", 0), false);
      const task = await rpc("claimHack", 1);
      assert.equal(Buffer.from(task.input).toString(), "4\n");
      const compilerArtifact = task.snapshot.testData["basic.in"];
      assert.deepEqual(Buffer.from(task.snapshot.artifacts[compilerArtifact], "base64"), Buffer.from("1\n"));
      assert.equal(await rpc("heartbeatHack", task.taskId), true);
      const report = {
        taskId: task.taskId,
        report: { outcome: "Succeeded", verdict: "WrongAnswer", output: Buffer.from("16\n") }
      };
      assert.equal(await rpc("finishHack", report), true);
      assert.equal(await rpc("finishHack", report), true);
      const final = await submissionRepo.findOneByOrFail({ id: target.id });
      assert.equal(final.status, "WrongAnswer");
      assert.equal(final.score, 0);
      assert.equal(+final.submitTime, +target.submitTime);
      assert.equal((await users.findOneByOrFail({ id: author.id })).acceptedProblemCount, 0);
      assert.equal((await post("hack/download", { id: created.id, input: true, output: true }))[0], 404);
      assert.equal((await post("hack/download", { id: created.id, input: true, output: true }, managerToken))[0], 201);
      const [ordinaryStatus, ordinaryDownload] = await post(
        "problem/downloadProblemFiles",
        {
          problemId: problem.id,
          type: "TestData",
          filenameList: ["basic.in"]
        },
        authorToken
      );
      assert.equal(ordinaryStatus, 201, JSON.stringify(ordinaryDownload));
      assert.equal(
        ordinaryDownload.remainingTestdataDownloads,
        isolatedConfig.resourceLimit.problemTestdataDailyDownloadFiles - 1
      );
      const [downloadStatus, download] = await post(
        "hack/download",
        { id: created.id, input: true, output: true },
        authorToken
      );
      assert.equal(downloadStatus, 201, JSON.stringify(download));
      assert.deepEqual(
        download.files.map(file => Buffer.from(file.data, "base64").toString()),
        ["4\n", "16\n"]
      );
      assert.equal(download.remaining, isolatedConfig.resourceLimit.problemTestdataDailyDownloadFiles - 3);
      assert.equal((await post("hack/history", { id: target.id }, authorToken))[1][0].challengerId, undefined);

      const playerRows = db.getRepository(ContestPlayerEntity);
      for (let i = 0; i < 20 && !(await playerRows.countBy({ contestId: contest.id, userId: author.id })); i++) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      const official = await playerRows.findOneByOrFail({
        contestId: contest.id,
        userId: author.id,
        ranklistScope: "official"
      });
      assert.equal(official.score, 0);
      const ordinaryTask = new Promise(resolve => {
        socket.once("task", (_thread, task, ack) => {
          ack();
          resolve(task);
        });
        socket.emit("consumeTask", 0);
      });
      assert.equal((await post("submission/rejudgeSubmission", { submissionId: target.id }, managerToken))[0], 201);
      const rejudge = await ordinaryTask;
      socket.emit("progress", {
        taskMeta: { taskId: rejudge.taskId, type: rejudge.type },
        progress: { progressType: "Finished", status: "Accepted", score: 100, totalOccupiedTime: 0.1 }
      });
      let replay;
      for (let i = 0; i < 20 && !replay; i++) {
        replay = await rpc("claimHack", 1);
        if (!replay) await new Promise(resolve => setTimeout(resolve, 250));
      }
      assert.ok(replay, "ordinary rejudge queued a new Hack verification");
      assert.equal(Buffer.from(replay.referenceOutput).toString(), "16\n");
      assert.equal(await rpc("finishHack", { ...report, taskId: replay.taskId }), true);
      assert.equal((await submissionRepo.findOneByOrFail({ id: target.id })).status, "WrongAnswer");
      assert.equal(
        (await post("hack/revoke", { id: created.id, reason: "Fixture verification" }, managerToken))[0],
        201
      );
      assert.equal((await submissionRepo.findOneByOrFail({ id: target.id })).status, "Accepted");
      assert.equal((await users.findOneByOrFail({ id: author.id })).acceptedProblemCount, 1);

      for (let attempt = 2; attempt <= 10; attempt++) {
        const [status] = await post("hack/create", { id: target.id, input: `invalid-${attempt}` });
        assert.equal(status, 201, `attempt ${attempt} fits in the daily quota`);
        const queued = await rpc("claimHack", 1);
        assert.equal(await rpc("finishHack", { taskId: queued.taskId, report: { outcome: "InvalidInput" } }), true);
      }
      const [overQuotaStatus, overQuota] = await post("hack/create", { id: target.id, input: "invalid-11" });
      assert.equal(overQuotaStatus, 409);
      assert.equal(overQuota.message, "HACK_DAILY_LIMIT");
    } finally {
      socket?.disconnect();
      try {
        await app?.close();
      } finally {
        for (const client of clients) client.disconnect();
        RedisService.prototype.getClient = getClient;
        RedisService.prototype.getSharedClient = getSharedClient;
      }
    }
  }
);
