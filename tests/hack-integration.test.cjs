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
  async t => {
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
    const { HackAttemptEntity } = require("../dist/hack/hack.entity");
    const { JudgeClientEntity } = require("../dist/judge/judge-client.entity");
    const { JudgeGateway } = require("../dist/judge/judge.gateway");
    const { LocalizedContentEntity } = require("../dist/localized-content/localized-content.entity");
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
    let judgeDisconnected;
    try {
      app = await NestFactory.create(AppModule, { logger: ["error", "warn"], abortOnError: false });
      app.setGlobalPrefix("api");
      app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
      const judgeGateway = app.get(JudgeGateway);
      const handleDisconnect = judgeGateway.handleDisconnect.bind(judgeGateway);
      judgeDisconnected = new Promise(resolve => {
        judgeGateway.handleDisconnect = client => {
          const result = handleDisconnect(client);
          resolve(result);
          return result;
        };
      });
      await app.listen(0, "127.0.0.1");
      const endpoint = await app.getUrl();
      const db = app.get(DataSource);
      const seed = Date.now().toString(36);
      const users = db.getRepository(UserEntity);
      const givenUser = (suffix, isAdmin = false, acceptedProblemCount = 0, rating = 0) =>
        users.save(
          users.create({
            username: seed + suffix,
            rating,
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
      const challenger = await givenUser("c", false, 0, Math.floor(Date.now() / 1000));
      const privateAuthor = await givenUser("p");
      const authorToken = await app.get(AuthSessionService).newSession(author, "127.0.0.1", "hack-fixture");
      const challengeToken = await app.get(AuthSessionService).newSession(challenger, "127.0.0.1", "hack-fixture");
      const managerToken = await app.get(AuthSessionService).newSession(manager, "127.0.0.1", "hack-fixture");
      const privateAuthorToken = await app
        .get(AuthSessionService)
        .newSession(privateAuthor, "127.0.0.1", "hack-fixture");
      const post = async (route, body, token = challengeToken) => {
        const response = await fetch(endpoint + "/api/" + route, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
          body: JSON.stringify(body)
        });
        return [response.status, await response.json()];
      };
      const successfulHackCount = async () => {
        const [status, result] = await post(
          "user/getUserList",
          { sortBy: "rating", skipCount: 0, takeCount: 10 },
          privateAuthorToken
        );
        assert.equal(status, 201, JSON.stringify(result));
        const row = result.userMetas.find(user => user.id === challenger.id);
        assert.ok(row, "the public list includes the challenger");
        return row.successfulHackCount;
      };

      const problems = db.getRepository(ProblemEntity);
      const problem = await problems.save(
        problems.create({
          ownerId: manager.id,
          type: "Traditional",
          isPublic: true,
          locales: ["zh_CN"],
          submissionCount: 2,
          acceptedSubmissionCount: 2
        })
      );
      await db.getRepository(LocalizedContentEntity).save({
        objectId: problem.id,
        type: "ProblemTitle",
        locale: "zh_CN",
        data: "Hack fixture"
      });
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
      const newSubmission = async (user, phase, overrides = {}) => {
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
            submitTime: new Date(now - 90000),
            ...overrides
          })
        );
        await db.getRepository(SubmissionDetailEntity).save({
          submissionId: target.id,
          result: { progressType: "Finished", status: target.status, score: target.score },
          content: { language: "cpp", code: "int main() {}", compileAndRunOptions: {} }
        });
        return target;
      };
      const target = await newSubmission(author, "official");
      const adminTarget = await newSubmission(manager, "official", { isPublic: false });
      const privatePractice = {
        contestId: null,
        contestProblemIndex: null,
        contestPhase: null,
        isPublic: false
      };
      const privateTarget = await newSubmission(privateAuthor, null, privatePractice);
      const failedTarget = await newSubmission(manager, null, { ...privatePractice, status: "WrongAnswer", score: 0 });
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

      const contestScope = { problemId: problem.id, contestId: contest.id };
      const statsQuery = {
        problemId: problem.id,
        locale: "zh_CN",
        statisticsType: "Earliest",
        skipCount: 0,
        takeCount: 10
      };
      const detailQuery = id => ({ submissionId: String(id), locale: "zh_CN" });
      const targetQuery = { id: target.id, contestId: contest.id };
      assert.deepEqual(await post("hack/targets", contestScope), [
        201,
        { enabled: true, inputLimit: 1048576, targets: [] }
      ]);
      assert.deepEqual(await post("hack/target", targetQuery), [201, { target: null }]);
      assert.equal((await post("hack/target", targetQuery, ""))[0], 401);
      assert.equal((await post("hack/create", { id: target.id, input: "4\n" }))[0], 404);
      assert.equal((await post("hack/history", { id: target.id }))[0], 404);
      assert.equal(
        (await post("submission/getSubmissionDetail", detailQuery(adminTarget.id)))[1].error,
        "PERMISSION_DENIED"
      );
      const [unqualifiedStatsStatus, unqualifiedStats] = await post("submission/querySubmissionStatistics", statsQuery);
      assert.equal(unqualifiedStatsStatus, 201);
      assert.equal(unqualifiedStats.error, undefined);
      assert.deepEqual(unqualifiedStats.submissions, []);

      const [adminStatus, adminHack] = await post("hack/create", { id: privateTarget.id, input: "4\n" }, managerToken);
      assert.equal(adminStatus, 201, JSON.stringify(adminHack));
      assert.equal((await post("hack/cancel", { id: adminHack.id }, managerToken))[0], 201);
      assert.equal((await post("hack/target", { id: failedTarget.id }, managerToken))[1].target, null);
      assert.equal(
        (await post("hack/create", { id: failedTarget.id, input: "4\n" }, managerToken))[1].message,
        "HACK_TARGET_NOT_ACCEPTED"
      );

      const qualifyingAC = await newSubmission(challenger, null, { ...privatePractice, isPublic: true });
      const [targetStatus, targets] = await post("hack/targets", contestScope);
      assert.equal(targetStatus, 201);
      assert.deepEqual(
        targets.targets.map(row => row.id),
        [adminTarget.id, target.id]
      );
      assert.deepEqual(Object.keys(targets.targets[0]).sort(), ["id", "language", "time"]);
      const list = (
        await post("submission/querySubmission", { problemId: problem.id, takeCount: 20, locale: "zh_CN" })
      )[1];
      assert.equal(list.permissionViewOthers, true);
      assert.deepEqual(
        list.submissions.map(row => row.id),
        [qualifyingAC.id, failedTarget.id, privateTarget.id, adminTarget.id, target.id]
      );
      const stats = (await post("submission/querySubmissionStatistics", statsQuery))[1];
      assert.ok(stats.submissions.some(row => row.id === adminTarget.id));
      assert.ok(stats.submissions.some(row => row.id === privateTarget.id));
      for (const id of [adminTarget.id, privateTarget.id, failedTarget.id]) {
        const detail = (await post("submission/getSubmissionDetail", detailQuery(id)))[1];
        assert.equal(detail.content.code, "int main() {}");
      }
      assert.deepEqual(await post("hack/target", { id: adminTarget.id, contestId: contest.id }), [
        201,
        { target: { ...targets.targets[0], inputLimit: 1048576 } }
      ]);
      const [challengeStatus, ordinaryHack] = await post("hack/create", { id: adminTarget.id, input: "4\n" });
      assert.equal(challengeStatus, 201, JSON.stringify(ordinaryHack));
      assert.equal((await post("hack/cancel", { id: ordinaryHack.id }))[0], 201);
      assert.deepEqual(await post("hack/target", { id: target.id }), [201, { target: null }]);
      assert.deepEqual(await post("hack/target", { id: target.id, contestId: contest.id + 1 }), [
        201,
        { target: null }
      ]);
      assert.equal((await post("hack/target", { id: privateTarget.id }))[1].target.id, privateTarget.id);
      assert.equal(
        (await post("hack/target", { id: privateTarget.id }, privateAuthorToken))[1].target.id,
        privateTarget.id
      );

      const preservedInput = "\n  4  \n\n";
      const [createdStatus, created] = await post("hack/create", { id: target.id, input: preservedInput });
      assert.equal(createdStatus, 201, JSON.stringify(created));
      assert.equal((await post("hack/create", { id: target.id, input: preservedInput }))[1].id, created.id);
      assert.equal((await post("hack/create", { id: target.id, input: "5\n" }))[1].message, "HACK_ALREADY_PENDING");
      await submissionRepo.update(qualifyingAC.id, { status: "WrongAnswer" });
      assert.deepEqual(await post("hack/target", targetQuery), [201, { target: null }]);
      assert.equal((await post("hack/create", { id: adminTarget.id, input: "5\n" }))[0], 404);
      assert.equal((await post("hack/create", { id: target.id, input: preservedInput }))[1].id, created.id);
      await submissionRepo.update(qualifyingAC.id, { status: "Accepted" });
      assert.equal(await successfulHackCount(), 0, "a newly queued Hack does not count");

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
      assert.equal(Buffer.from(task.input).toString(), preservedInput);
      const compilerArtifact = task.snapshot.testData["basic.in"];
      assert.deepEqual(Buffer.from(task.snapshot.artifacts[compilerArtifact], "base64"), Buffer.from("1\n"));
      assert.equal(await rpc("heartbeatHack", task.taskId), true);
      const report = {
        taskId: task.taskId,
        report: { outcome: "Succeeded", verdict: "WrongAnswer", output: Buffer.from("16\n") }
      };
      assert.equal(await rpc("finishHack", report), true);
      assert.equal(await rpc("finishHack", report), true);
      assert.equal(
        await successfulHackCount(),
        1,
        "another user can see the success and the duplicate report counts once"
      );
      const final = await submissionRepo.findOneByOrFail({ id: target.id });
      assert.equal(final.status, "WrongAnswer");
      assert.equal(final.score, 0);
      assert.deepEqual(await post("hack/target", { id: target.id, contestId: contest.id }), [201, { target: null }]);
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
        [preservedInput, "16\n"]
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
      assert.equal(await successfulHackCount(), 1, "an in-flight recheck retains the successful Hack");
      assert.equal(await rpc("finishHack", { ...report, taskId: replay.taskId }), true);
      assert.equal(await successfulHackCount(), 1, "reconfirming the same Hack adds no success");
      assert.equal((await submissionRepo.findOneByOrFail({ id: target.id })).status, "WrongAnswer");
      assert.equal(
        (await post("hack/revoke", { id: created.id, reason: "Fixture verification" }, managerToken))[0],
        201
      );
      assert.equal((await submissionRepo.findOneByOrFail({ id: target.id })).status, "Accepted");
      assert.equal((await users.findOneByOrFail({ id: author.id })).acceptedProblemCount, 1);
      assert.equal(await successfulHackCount(), 0, "revocation removes the success from the public list");

      for (let attempt = 2; attempt <= 10; attempt++) {
        const [status] = await post("hack/create", { id: target.id, input: `invalid-${attempt}` });
        assert.equal(status, 201, `attempt ${attempt} fits in the daily quota`);
        const queued = await rpc("claimHack", 1);
        assert.equal(await rpc("finishHack", { taskId: queued.taskId, report: { outcome: "InvalidInput" } }), true);
      }
      const [overQuotaStatus, overQuota] = await post("hack/create", { id: target.id, input: "invalid-11" });
      assert.equal(overQuotaStatus, 409);
      assert.equal(overQuota.message, "HACK_DAILY_LIMIT");
      assert.equal(await successfulHackCount(), 0, "invalid inputs add no successes");

      const board = async (id, ranklistScope = "official") => {
        const [status, response] = await post("contest/getContestRanklist", {
          contestId: id,
          ranklistScope,
          locale: "zh_CN"
        });
        assert.equal(status, 201, JSON.stringify(response));
        assert.equal(response.error, undefined);
        return response;
      };
      const startHack = async (submission, token = managerToken) => {
        const [status, response] = await post("hack/create", { id: submission.id, input: "16\n" }, token);
        assert.equal(status, 201, JSON.stringify(response));
        return response;
      };
      const finishHack = async work => {
        assert.ok(work?.taskId);
        assert.equal(await rpc("finishHack", { ...report, taskId: work.taskId }), true);
      };
      const newContest = async (type, rankingParams = null) =>
        await contests.save(
          contests.create({
            title: `${seed}-${type}`,
            subtitle: "",
            information: "",
            type,
            isPublic: true,
            hideStatistics: false,
            holderId: manager.id,
            problemIds: [problem.id],
            adminIds: [],
            startTime: new Date(now - 4 * 60 * 60 * 1000),
            endTime: new Date(now - 30000),
            rankingParams
          })
        );
      const waitFor = async check => {
        for (let attempt = 0; attempt < 30; attempt++) {
          const result = await check();
          if (result) return result;
          await new Promise(resolve => setTimeout(resolve, 250));
        }
        assert.fail("ranklist did not reflect the result");
      };

      const practice = await newSubmission(author, null, { contestId: null, contestProblemIndex: null });
      await startHack(practice);
      await finishHack(await rpc("claimHack", 1));
      let changed = await submissionRepo.findOneByOrFail({ id: practice.id });
      assert.deepEqual([changed.status, changed.score], ["WrongAnswer", 100]);

      const practiceRejudge = new Promise(resolve => {
        socket.once("task", (_thread, task, ack) => {
          ack();
          resolve(task);
        });
        socket.emit("consumeTask", 0);
      });
      assert.equal((await post("submission/rejudgeSubmission", { submissionId: practice.id }, managerToken))[0], 201);
      const practiceTask = await practiceRejudge;
      socket.emit("progress", {
        taskMeta: { taskId: practiceTask.taskId, type: practiceTask.type },
        progress: { progressType: "Finished", status: "Accepted", score: 100, totalOccupiedTime: 0.1 }
      });
      let failedReplay = await waitFor(() => rpc("claimHack", 1));
      for (let run = 0; run < 3; run++) {
        assert.equal(await rpc("finishHack", { taskId: failedReplay.taskId, report: { outcome: "JudgeError" } }), true);
        if (run < 2) failedReplay = await waitFor(() => rpc("claimHack", 1));
      }
      changed = await submissionRepo.findOneByOrFail({ id: practice.id });
      assert.deepEqual([changed.status, changed.score], ["WrongAnswer", 100]);

      for (const type of ["ioi", "noi"]) {
        const scoredContest = await newContest(type, { [problem.id]: 1.5 });
        const scored = await newSubmission(author, "official", { contestId: scoredContest.id });
        await startHack(scored);
        await finishHack(await rpc("claimHack", 1));
        changed = await submissionRepo.findOneByOrFail({ id: scored.id });
        assert.deepEqual([changed.status, changed.score], ["WrongAnswer", 100]);
        const rows = await waitFor(async () => {
          const result = await board(scoredContest.id);
          assert.equal(result.officialRanklistStatus, "review");
          return result.rows.length && result.rows;
        });
        assert.equal(rows[0].score, 150);
        assert.equal(rows[0].scoreDetails[problem.id].status, "WrongAnswer");
        await contests.update(scoredContest.id, { endTime: new Date(now - 2 * 60 * 60 * 1000 - 30000) });
        if (type === "noi") {
          await waitFor(async () => (await contests.findOneByOrFail({ id: scoredContest.id })).officialRanklist);
        }
        const scoredSnapshot = await board(scoredContest.id);
        assert.equal(scoredSnapshot.officialRanklistStatus, "finalized");
        await contests.update(scoredContest.id, { rankingParams: { [problem.id]: 2 } });
        assert.deepEqual((await board(scoredContest.id)).rows, scoredSnapshot.rows);
        assert.equal((await board(scoredContest.id, "combined")).rows[0].score, 200);
      }

      const sealing = await newContest("acm");
      const first = await newSubmission(author, "official", {
        contestId: sealing.id,
        submitTime: new Date(+sealing.startTime + 12 * 60 * 1000)
      });
      const second = await newSubmission(author, null, {
        contestId: sealing.id,
        submitTime: new Date(+sealing.startTime + 30 * 60 * 1000)
      });
      const early = await startHack(first);
      const cutoff = new Date(now - 10000);
      const attempts = db.getRepository(HackAttemptEntity);
      await attempts.update(early.id, { createdAt: new Date(+cutoff - 1000) });
      await contests.update(sealing.id, { endTime: new Date(+cutoff - 2 * 60 * 60 * 1000) });
      const late = await startHack(second, privateAuthorToken);
      await attempts.update(late.id, { createdAt: cutoff });
      const settling = await board(sealing.id);
      assert.equal(settling.officialRanklistStatus, "settling");
      assert.equal(settling.officialRanklistReviewEndsAt, cutoff.toISOString());

      await finishHack(await rpc("claimHack", 1));
      assert.equal((await attempts.findOneByOrFail({ id: late.id })).state, "Queued");
      const finalized = await board(sealing.id);
      assert.equal(finalized.officialRanklistStatus, "finalized");
      assert.equal(finalized.rows[0].score, 1);
      assert.equal(finalized.rows[0].timeSpent, 50 * 60);
      assert.equal(finalized.rows[0].scoreDetails[problem.id].unacceptedCount, 1);
      assert.equal(finalized.rows[0].scoreDetails[problem.id].submissionId, second.id);

      await finishHack(await rpc("claimHack", 1));
      changed = await submissionRepo.findOneByOrFail({ id: second.id });
      assert.deepEqual([changed.status, changed.score], ["WrongAnswer", 0]);
      await waitFor(async () => (await board(sealing.id, "combined")).rows[0]?.score === 0);
      assert.deepEqual((await board(sealing.id)).rows, finalized.rows);
      assert.equal((await post("hack/revoke", { id: early.id, reason: "Fixture verification" }, managerToken))[0], 201);
      await waitFor(async () => (await board(sealing.id, "combined")).rows[0]?.score === 1);
      assert.deepEqual((await board(sealing.id)).rows, finalized.rows);
    } finally {
      try {
        if (socket?.connected) {
          // Await the Redis cleanup and discard the delayed offline warning before closing Redis.
          t.mock.timers.enable({ apis: ["setTimeout"] });
          try {
            socket.disconnect();
            await judgeDisconnected;
          } finally {
            t.mock.timers.reset();
          }
        } else {
          socket?.disconnect();
        }
      } finally {
        try {
          await app?.close();
        } finally {
          for (const client of clients) client.disconnect();
          RedisService.prototype.getClient = getClient;
          RedisService.prototype.getSharedClient = getSharedClient;
        }
      }
    }
  }
);
