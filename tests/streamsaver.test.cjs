const assert = require("node:assert/strict");
const { test } = require("node:test");
const vm = require("node:vm");
const path = require("node:path");

require("reflect-metadata");
require("tsconfig-paths").register({ baseUrl: path.resolve(__dirname, "../dist"), paths: { "@/*": ["*"] } });
const { CorsController } = require("../dist/cors/cors.controller");

for (const existingScope of [null, "/", "/api/cors/streamsaver/"]) {
  test(`archive messages reach the download worker with existing scope ${existingScope}`, async () => {
    const pageUrl = new URL("https://nsoj.top/api/cors/streamsaver/mitm.html?worker=2");
    const workerScope = new URL("./", pageUrl).href;
    const registrations = [];
    const messages = [];
    const worker = {
      scope: workerScope,
      active: { postMessage: (data, ports) => messages.push({ data, ports }) }
    };
    const notificationWorker = {
      scope: "https://nsoj.top/",
      active: { postMessage: () => assert.fail("Download sent to notification worker") }
    };
    const context = {
      window: {},
      document: { referrer: "https://nsoj.top/problem/1/files" },
      location: pageUrl,
      navigator: {
        serviceWorker: {
          // Match the browser's longest enclosing scope lookup, including /.
          getRegistration: async () =>
            existingScope === "/" ? notificationWorker : existingScope ? worker : undefined,
          register: async (script, options) => {
            registrations.push({ script: new URL(script, pageUrl).href, scope: new URL(options.scope, pageUrl).href });
            return worker;
          }
        }
      },
      Headers,
      URL,
      URLSearchParams,
      console
    };
    const html = await new CorsController({}).streamsaverMitm();
    vm.runInNewContext(html.replace(/^<script>|<\/script>$/g, ""), context);
    // Send before worker registration completes, as StreamSaver does on iframe load.
    const port = {};
    context.window.onmessage({
      data: { pathname: "123/TestData_1.zip", headers: {}, transferringReadable: true },
      ports: [port],
      origin: pageUrl.origin
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(registrations.length > 0, "Must explicitly register the download worker");
    assert.equal(registrations[0].script, new URL("sw.js", pageUrl).href);
    assert.equal(registrations[0].scope, workerScope);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].data.url, `${workerScope}nsoj.top/123/TestData_1.zip`);
    assert.equal(messages[0].ports[0], port);
  });
}
