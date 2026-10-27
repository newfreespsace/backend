const assert = require("node:assert/strict");
const { test } = require("node:test");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

// Each probe starts with an empty module cache, as yarn dev does. Service tests that
// import UserService first cannot detect undefined decorator metadata in app-first loading.
const probe = String.raw`
require("reflect-metadata");
const assert = require("node:assert/strict");
const path = require("node:path");
// Load production output without a runtime alias hook: Nest must rewrite @/
// imports during compilation, just as node dist/main expects.

// AuthController imports version information from main. Keep that import from
// starting the actual server, connecting to a database, or synchronizing a schema.
const main = path.resolve("dist/main.js");
require.cache[main] = {id:main,filename:main,loaded:true,exports:{appGitRepoInfo:{}}};
const entry = process.argv[1];
if (entry === "remote-first") require("./dist/remote-judge/remote-judge.module");
if (entry === "user-first") require("./dist/user/user.module");
const {AppModule} = require("./dist/app.module");
const {NestContainer} = require("@nestjs/core/injector/container");
const {Injector} = require("@nestjs/core/injector/injector");
const {STATIC_CONTEXT} = require("@nestjs/core/injector/constants");
const {ApplicationConfig} = require("@nestjs/core/application-config");
const {DependenciesScanner} = require("@nestjs/core/scanner");
const {MetadataScanner} = require("@nestjs/core/metadata-scanner");
const {GraphInspector} = require("@nestjs/core/inspector/graph-inspector");

(async()=>{
  const config = new ApplicationConfig();
  const container = new NestContainer(config);
  const scanner = new DependenciesScanner(container,new MetadataScanner(),new GraphInspector(container),config);
  await scanner.scan(AppModule);
  const wrappers = [];
  for (const mod of container.getModules().values()) {
    for (const wrapper of [...mod.providers.values(),...mod.controllers.values(),...mod.injectables.values()]) {
      wrappers.push({mod,wrapper});
      // Resolve real Nest tokens and module scopes, without constructing external
      // database, Redis, MinIO, metrics or worker connections.
      wrapper.setInstanceByContextId(STATIC_CONTEXT,{instance:{},isResolved:true});
    }
  }
  // Gateways sharing /api/socket reuse the first Engine.IO server's options.
  // Adding notifications must preserve the judge's existing payload limit.
  const {GATEWAY_METADATA,GATEWAY_OPTIONS} = require("@nestjs/websockets/constants");
  const socketGateways = wrappers.filter(({wrapper}) => typeof wrapper.metatype === "function" &&
    Reflect.getMetadata(GATEWAY_METADATA,wrapper.metatype)).map(({wrapper}) =>
      Reflect.getMetadata(GATEWAY_OPTIONS,wrapper.metatype)).filter(options => options.path === "/api/socket");
  assert.equal(socketGateways[0].maxHttpBufferSize,1e9);

  const injector = new Injector();
  let checked = 0;
  for (const {mod,wrapper} of wrappers) {
    if (typeof wrapper.metatype !== "function") continue;
    await injector.resolveConstructorParams(wrapper,mod,wrapper.inject,()=>{checked++;});
  }
  assert.ok(checked > 100);

  // Instantiate the exact service from the reported error with its real audit
  // provider, while replacing only infrastructure and unrelated service objects.
  const {UserService} = require("./dist/user/user.service");
  const {AuditService,AuditLogObjectType} = require("./dist/audit/audit.service");
  const {AuditLogEntity} = require("./dist/audit/audit-log.entity");
  const {getRepositoryToken} = require("@nestjs/typeorm");
  const {Module} = require("@nestjs/common");
  const {NestFactory} = require("@nestjs/core");
  const tokens = [...(Reflect.getMetadata("design:paramtypes",UserService)||[])];
  for (const {index,param} of Reflect.getMetadata("self:paramtypes",UserService)||[]) tokens[index]=param;
  const providers = tokens.map(token=>token?.forwardRef?token.forwardRef():token)
    .filter(token=>token!==AuditService).map(token=>({provide:token,useValue:{}}));
  class ServiceBootstrapModule {}
  Module({providers:[...providers,{provide:getRepositoryToken(AuditLogEntity),useValue:{}},AuditService,UserService]})(ServiceBootstrapModule);
  const app = await NestFactory.createApplicationContext(ServiceBootstrapModule,{logger:false,abortOnError:false});
  assert.equal(app.get(UserService).auditService,app.get(AuditService));
  assert.equal(typeof app.get(AuditService).objectTypeQueryHandlers[AuditLogObjectType.User],"function");
  await app.close();
  process.stdout.write(JSON.stringify({entry,modules:container.getModules().size,checked}));
})().catch(error=>{console.error(error);process.exitCode=1;});
`;

for (const entry of ["app-first", "remote-first", "user-first"]) {
  test(`Nest resolves startup dependencies with ${entry} imports`, () => {
    const result = spawnSync(process.execPath, ["-e", probe, entry], {
      cwd: path.resolve(__dirname, ".."),
      encoding: "utf8",
      timeout: 20000
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message || result.stdout);
    const summary = JSON.parse(result.stdout);
    assert.ok(summary.modules > 50);
    assert.ok(summary.checked > 100);
  });
}
