const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nsoj-local-env-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "dist/config");
  fs.mkdirSync(directory, { recursive: true });
  const loader = path.join(directory, "load-local-env.js");
  fs.copyFileSync(path.resolve(__dirname, "../dist/config/load-local-env.js"), loader);
  return { root, loader };
}

function probe(loader, script, overrides = {}) {
  const result = spawnSync(process.execPath, ["-e", script, loader], {
    // Use a different directory to catch accidental dependence on process.cwd().
    cwd: os.tmpdir(),
    env: { ...process.env, ...overrides },
    encoding: "utf8",
    timeout: 5000
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
}

test("loads .env.local from the backend root before modules read environment variables", t => {
  const { root, loader } = fixture(t);
  fs.writeFileSync(path.join(root, ".env.local"), 'NSOJ_ENV_FILE_TEST="file value # preserved"\n');
  probe(
    loader,
    `
    require(process.argv[1]);
    require('node:assert/strict').equal(process.env.NSOJ_ENV_FILE_TEST, 'file value # preserved');
  `
  );
});

test("existing shell/deployment variables, including empty values, take precedence", t => {
  const { root, loader } = fixture(t);
  fs.writeFileSync(path.join(root, ".env.local"), "NSOJ_ENV_FILE_TEST=file\nNSOJ_ENV_EMPTY_TEST=file\n");
  probe(
    loader,
    `
    require(process.argv[1]);
    const assert = require('node:assert/strict');
    assert.equal(process.env.NSOJ_ENV_FILE_TEST, 'deployment');
    assert.equal(process.env.NSOJ_ENV_EMPTY_TEST, '');
  `,
    { NSOJ_ENV_FILE_TEST: "deployment", NSOJ_ENV_EMPTY_TEST: "" }
  );
});

test("a missing local file is optional for deployments that inject configuration", t => {
  const { loader } = fixture(t);
  probe(loader, `require(process.argv[1]);`);
});

test("filesystem errors other than a missing file are reported", t => {
  const { root, loader } = fixture(t);
  fs.mkdirSync(path.join(root, ".env.local"));
  probe(
    loader,
    `
    require('node:assert/strict').throws(() => require(process.argv[1]),
      error => ['EISDIR', 'ERR_INVALID_ARG_TYPE'].includes(error.code));
  `
  );
});
