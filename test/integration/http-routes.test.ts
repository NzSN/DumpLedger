import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";

import { FixedWindowRateLimiter } from "../../src/auth/rate-limiter.js";
import { OperatorSessions, hashOperatorPassword } from "../../src/auth/sessions.js";
import { createDumpLedgerEngine, DeterministicClock, DeterministicEntropy, DeterministicIds } from "../../src/engine/dump-ledger-engine.js";
import { EngineHttpApplication } from "../../src/http/application.js";
import { buildHttpServer, type HttpApplicationPort, type HttpProjection, type HttpServerOptions } from "../../src/http/server.js";
import { createVaultMinidumpInspectionPort } from "../../src/inspection/index.js";
import { UploadAdmission } from "../../src/intake/upload-admission.js";
import { EngineUploadLifecycle, EngineUploadPostProcessor, VaultUploadSink } from "../../src/intake/intake-facade.js";
import { PostProcessingQueue } from "../../src/intake/post-processing-queue.js";
import type { UploadLifecyclePort } from "../../src/intake/upload-session.js";
import { MemoryVault } from "../../src/vault/memory-vault.js";
import { syntheticMinidump } from "../fixtures/minidump/synthetic-minidump.js";

async function fixture(overrides: Partial<HttpServerOptions> = {}) {
  const projection: HttpProjection = { customers: [], cases: [], grants: [], dumps: [], auditEvents: [] };
  const uploads: unknown[] = [];
  let consumed = false;
  const application: HttpApplicationPort = {
    snapshot: () => projection,
    createCustomer(displayName) { const customer = { customerId: "customer-1", displayName }; projection.customers.push(customer); return { ok: true, id: customer.customerId }; },
    createCase(customerId, title) { const item = { caseId: "case-1", customerId, title, status: "open" }; projection.cases.push(item); return { ok: true, id: item.caseId }; },
    issueGrant(caseId, expiresAt, maxBytes) { projection.grants.push({ grantId: "grant-1", caseId, state: "issued", expiresAt, maxBytes }); return { ok: true, id: "grant-1", secret: "a".repeat(43) }; },
    revokeGrant: () => ({ ok: true }),
    setRetention: () => ({ ok: true }),
    caseManifest: caseId => ({ caseId, dumps: [] }),
    openDownload: dumpId => dumpId === "dump-available" ? { phase: "available", byteSize: 3n, bytes: Readable.from([Buffer.from("dmp")]) } : undefined,
  };
  const lifecycle: UploadLifecyclePort = {
    begin(input) {
      uploads.push({ action: "begin", ...input });
      if (input.grantSecret !== "a".repeat(43) || consumed) return { ok: false, code: "grant_invalid" };
      consumed = true;
      return { ok: true, dumpId: "dump-uploaded", maxBytes: 256n * 1024n };
    },
    seal(input) { uploads.push({ action: "seal", ...input }); return { ok: true }; },
    fail(input) { uploads.push({ action: "fail", ...input }); return { ok: true }; },
  };
  const appended: Buffer[] = [];
  const sessions = new OperatorSessions({ passwordHash: await hashOperatorPassword("local-password"), secureCookies: false });
  const server = buildHttpServer({
    application,
    sessions,
    uploadLifecycle: lifecycle,
    uploadSink: { append(_dumpId, chunk) { appended.push(Buffer.from(chunk)); }, syncAndClose() {} },
    ...overrides,
  });
  return { server, projection, uploads, appended };
}

async function login(server: Awaited<ReturnType<typeof fixture>>["server"]) {
  const response = await server.inject({ method: "POST", url: "/login", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "password=local-password" });
  assert.equal(response.statusCode, 303);
  const setCookie = response.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";", 1)[0];
  assert.ok(cookie);
  const home = await server.inject({ method: "GET", url: "/", headers: { cookie } });
  const match = home.body.match(/name="csrf" value="([^"]+)"/);
  assert.ok(match?.[1]);
  return { cookie, csrf: match[1] };
}

test("operator creates a customer and case through CSRF-protected HTML forms", async t => {
  const { server, projection } = await fixture();
  t.after(() => server.close());
  const auth = await login(server);
  const rejected = await server.inject({ method: "POST", url: "/customers", headers: { cookie: auth.cookie, "content-type": "application/x-www-form-urlencoded" }, payload: "displayName=Acme" });
  assert.equal(rejected.statusCode, 403);
  assert.equal((await server.inject({ method: "POST", url: "/customers", headers: { cookie: auth.cookie, "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams({ csrf: auth.csrf, displayName: "Acme <Support>" }).toString() })).statusCode, 303);
  const createdCase = await server.inject({ method: "POST", url: "/customers/customer-1/cases", headers: { cookie: auth.cookie, "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams({ csrf: auth.csrf, title: "Crash 42" }).toString() });
  assert.equal(createdCase.statusCode, 303);
  assert.equal(createdCase.headers.location, "/cases/case-1");
  assert.equal(projection.customers[0]?.displayName, "Acme <Support>");
  assert.equal(projection.cases[0]?.customerId, "customer-1");
});

test("case grant drives a raw streaming upload and replay fails closed", async t => {
  const { server, uploads, appended } = await fixture();
  t.after(() => server.close());
  const secret = "a".repeat(43);
  const page = await server.inject({ method: "GET", url: `/upload/${secret}` });
  assert.equal(page.statusCode, 200);
  assert.equal(page.headers["referrer-policy"], "no-referrer");
  assert.match(page.body, /process memory may contain secrets/i);
  const uploaded = await server.inject({ method: "POST", url: `/upload/${secret}`, headers: { "content-type": "application/octet-stream", "x-dump-filename": "customer.dmp" }, payload: Buffer.from("MDMP") });
  assert.equal(uploaded.statusCode, 201);
  assert.deepEqual(Buffer.concat(appended), Buffer.from("MDMP"));
  assert.deepEqual(uploads.map(value => (value as { action: string }).action), ["begin", "seal"]);
  const replay = await server.inject({ method: "POST", url: `/upload/${secret}`, headers: { "content-type": "application/octet-stream" }, payload: Buffer.from("MDMP") });
  assert.equal(replay.statusCode, 404);
  assert.equal(replay.json().error, "grant_invalid");
  assert.deepEqual(Buffer.concat(appended), Buffer.from("MDMP"));
});

test("Fastify streams uploads larger than its form body budget", async t => {
  const { server, uploads, appended } = await fixture();
  t.after(() => server.close());
  const response = await server.inject({ method: "POST", url: `/upload/${"a".repeat(43)}`, headers: { "content-type": "application/octet-stream" }, payload: Buffer.alloc(128 * 1024, 0x5a) });
  assert.equal(response.statusCode, 201);
  assert.equal(Buffer.concat(appended).byteLength, 128 * 1024);
  const sealed = uploads.at(-1) as { action: string; byteSize: bigint; sha256: string };
  assert.equal(sealed.action, "seal");
  assert.equal(sealed.byteSize, 128n * 1024n);
  assert.equal(sealed.sha256, "4742cc452b30002f46343efd2714e07f0dd467da4a83d396a025468f5e8ba495");
});

test("download requires an operator and an available dump", async t => {
  const { server } = await fixture();
  t.after(() => server.close());
  assert.equal((await server.inject({ method: "GET", url: "/dumps/dump-available/download" })).statusCode, 303);
  const auth = await login(server);
  assert.equal((await server.inject({ method: "GET", url: "/dumps/dump-rejected/download", headers: { cookie: auth.cookie } })).statusCode, 404);
  const available = await server.inject({ method: "GET", url: "/dumps/dump-available/download", headers: { cookie: auth.cookie } });
  assert.equal(available.statusCode, 200);
  assert.equal(available.body, "dmp");
  assert.equal(available.headers["content-disposition"], "attachment; filename=\"dump-available.dmp\"");
});

test("health endpoint is public and operations health is private", async t => {
  const { server } = await fixture();
  t.after(() => server.close());
  const response = await server.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ok" });
  assert.equal(response.headers["strict-transport-security"], undefined);
  assert.equal((await server.inject({ method: "GET", url: "/operations/health" })).statusCode, 303);
});

test("browser pages render responsive local-only application chrome", async t => {
  const { server } = await fixture();
  t.after(() => server.close());

  const loginPage = await server.inject({ method: "GET", url: "/login" });
  assert.equal(loginPage.statusCode, 200);
  assert.match(loginPage.body, /class="public-page auth-page"/);
  assert.match(loginPage.body, /class="brand-mark"/);
  assert.match(loginPage.body, /class="auth-card"/);
  assert.match(loginPage.body, /href="\/assets\/app\.css"/);
  assert.match(loginPage.body, /src="\/assets\/app\.js"/);
  assert.doesNotMatch(loginPage.body, /https?:\/\/[^"']+\.(?:css|js)/i);

  const auth = await login(server);
  const dashboard = await server.inject({ method: "GET", url: "/", headers: { cookie: auth.cookie } });
  assert.match(dashboard.body, /class="metric-grid"/);
  assert.match(dashboard.body, /class="layout-grid"/);
  assert.match(dashboard.body, /Private by design/);

  const operations = await server.inject({ method: "GET", url: "/operations", headers: { cookie: auth.cookie } });
  assert.equal(operations.statusCode, 200);
  assert.match(operations.body, /Runtime overview/);
  assert.match(operations.body, /class="status status-good">ok/);

  const uploadPage = await server.inject({ method: "GET", url: `/upload/${"a".repeat(43)}` });
  assert.match(uploadPage.body, /id="drop-zone"/);
  assert.match(uploadPage.body, /role="progressbar"/);
  assert.match(uploadPage.body, /src="\/assets\/upload\.js"/);
  assert.doesNotMatch(uploadPage.body, /<style|on(?:click|change|drop)=/i);

  const css = await server.inject({ method: "GET", url: "/assets/app.css" });
  assert.equal(css.statusCode, 200);
  assert.match(css.body, /radial-gradient/);
  assert.match(css.body, /@media \(max-width: 600px\)/);
  const uploadScript = await server.inject({ method: "GET", url: "/assets/upload.js" });
  assert.match(uploadScript.body, /XMLHttpRequest/);
  assert.match(uploadScript.body, /upload-progress-bar/);
});

test("HSTS is emitted only for an explicitly secure deployment", async t => {
  const { server } = await fixture({ secureDeployment: true });
  t.after(() => server.close());
  assert.equal((await server.inject({ method: "GET", url: "/health" })).headers["strict-transport-security"], "max-age=31536000");
});

test("login rate limiting is deterministic and resets on the injected clock", async t => {
  let now = 10_000;
  const limiter = new FixedWindowRateLimiter({ limit: 1, windowMs: 100, maxKeys: 4, now: () => now });
  const { server } = await fixture({ loginRateLimiter: limiter, now: () => now });
  t.after(() => server.close());
  const attempt = (password: string) => server.inject({ method: "POST", url: "/login", headers: { "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams({ password }).toString() });
  assert.equal((await attempt("wrong-password")).statusCode, 401);
  assert.equal((await attempt("local-password")).statusCode, 429);
  now += 100;
  assert.equal((await attempt("local-password")).statusCode, 303);
});

test("grant verification rate limiting occurs before a second grant or body is consumed", async t => {
  let now = 20_000;
  const limiter = new FixedWindowRateLimiter({ limit: 1, windowMs: 100, maxKeys: 4, now: () => now });
  const { server, uploads, appended } = await fixture({ uploadGrantRateLimiter: limiter, now: () => now });
  t.after(() => server.close());
  const post = (secret: string) => server.inject({ method: "POST", url: `/upload/${secret}`, headers: { "content-type": "application/octet-stream" }, payload: Buffer.from("MDMP") });
  assert.equal((await post("b".repeat(43))).statusCode, 404);
  assert.equal((await post("a".repeat(43))).statusCode, 429);
  assert.equal(uploads.length, 1);
  assert.equal(appended.length, 0);
  now += 100;
  assert.equal((await post("a".repeat(43))).statusCode, 201);
});

test("upload admission rejects excess work before consuming a grant or request body", async t => {
  const admission = new UploadAdmission(1);
  const occupied = admission.tryAcquire();
  assert.ok(occupied);
  const { server, uploads, appended } = await fixture({ uploadAdmission: admission });
  t.after(() => server.close());
  const rejected = await server.inject({ method: "POST", url: `/upload/${"a".repeat(43)}`, headers: { "content-type": "application/octet-stream" }, payload: Buffer.alloc(64 * 1024) });
  assert.equal(rejected.statusCode, 503);
  assert.deepEqual(uploads, []);
  assert.deepEqual(appended, []);
  occupied.release();
});

test("a post-processing failure is queued and retried without sleeping", async t => {
  const callbacks: Array<() => void> = [];
  let attempts = 0;
  const processor = { process() { attempts += 1; if (attempts === 1) throw new Error("transient"); return "available" as const; } };
  const queue = new PostProcessingQueue({ processor, schedule: callback => { callbacks.push(callback); return callback; }, cancel: () => {} });
  const { server } = await fixture({ uploadPostProcessor: processor, postProcessingQueue: queue });
  t.after(async () => { queue.close(); await server.close(); });
  const response = await server.inject({ method: "POST", url: `/upload/${"a".repeat(43)}`, headers: { "content-type": "application/octet-stream" }, payload: Buffer.from("MDMP") });
  assert.equal(response.statusCode, 202);
  assert.equal(response.json().processing, "retry-queued");
  assert.equal(queue.snapshot().pending, 1);
  callbacks.shift()?.();
  assert.equal(attempts, 2);
  assert.equal(queue.snapshot().pending, 0);
});

test("an invalid Content-Length is rejected without starting intake", async t => {
  const { server, uploads } = await fixture();
  t.after(() => server.close());
  const response = await server.inject({ method: "POST", url: `/upload/${"a".repeat(43)}`, headers: { "content-type": "application/octet-stream", "content-length": "-1" }, payload: Buffer.from("MDMP") });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(uploads, []);
});

test("HTTP creation and upload routes reach the production lifecycle engine", async t => {
  const vault = new MemoryVault();
  const engine = createDumpLedgerEngine({
    databasePath: ":memory:", vault, inspection: createVaultMinidumpInspectionPort(vault), grantSecretKey: Buffer.alloc(32, 0x5a),
    clock: new DeterministicClock("2026-09-04T12:00:00.000Z"), entropy: new DeterministicEntropy(["s".repeat(43), "t".repeat(43)]), ids: new DeterministicIds(),
  });
  const sessions = new OperatorSessions({ passwordHash: await hashOperatorPassword("local-password"), secureCookies: false });
  const server = buildHttpServer({
    application: new EngineHttpApplication(engine, vault), sessions, uploadLifecycle: new EngineUploadLifecycle(engine), uploadSink: new VaultUploadSink(vault), uploadPostProcessor: new EngineUploadPostProcessor(engine), now: () => Date.parse("2026-09-04T12:00:00.000Z"),
  });
  t.after(async () => { await server.close(); engine.close(); });
  const auth = await login(server);
  const operations = await server.inject({ method: "GET", url: "/operations/health", headers: { cookie: auth.cookie } });
  assert.equal(operations.statusCode, 200);
  assert.equal(operations.json().status, "ok");
  assert.equal((await server.inject({ method: "POST", url: "/customers", headers: { cookie: auth.cookie, "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams({ csrf: auth.csrf, displayName: "Acme" }).toString() })).statusCode, 303);
  const customerId = engine.snapshot().customers[0]?.customerId;
  assert.ok(customerId);
  assert.equal((await server.inject({ method: "POST", url: `/customers/${customerId}/cases`, headers: { cookie: auth.cookie, "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams({ csrf: auth.csrf, title: "Renderer crash" }).toString() })).statusCode, 303);
  const caseId = engine.snapshot().cases[0]?.caseId;
  assert.ok(caseId);
  const grant = await server.inject({ method: "POST", url: `/cases/${caseId}/grants`, headers: { cookie: auth.cookie, "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams({ csrf: auth.csrf, hours: "24", maxBytes: "2048" }).toString() });
  assert.match(grant.body, /data-copy-target="#upload-link"/);
  const uploadPath = grant.body.match(/\/upload\/[A-Za-z0-9_-]{43,128}/)?.[0];
  assert.ok(uploadPath);
  const validDump = syntheticMinidump({ memoryListSizes: [8] });
  const uploadResponse = await server.inject({ method: "POST", url: uploadPath, headers: { "content-type": "application/octet-stream", "x-dump-filename": "renderer.dmp" }, payload: validDump });
  assert.equal(uploadResponse.statusCode, 201);
  assert.equal(uploadResponse.json().phase, "available");
  assert.deepEqual(engine.snapshot().auditEvents.slice(-5).map(event => event.action), ["BeginUpload", "SealUpload", "PromoteObject", "MarkQuarantined", "AcceptDump"]);
  const manifest = await server.inject({ method: "GET", url: `/cases/${caseId}/manifest.json`, headers: { cookie: auth.cookie } });
  assert.equal(manifest.json().dumps[0].byteSize, "72");
  const realDumpId = engine.snapshot().dumps[0]?.dumpId;
  assert.ok(realDumpId);
  const downloaded = await server.inject({ method: "GET", url: `/dumps/${realDumpId}/download`, headers: { cookie: auth.cookie } });
  assert.deepEqual(downloaded.rawPayload, validDump);
  assert.equal(engine.snapshot().auditEvents.at(-1)?.action, "AuthorizeDownload");
  const dumpPage = await server.inject({ method: "GET", url: `/dumps/${realDumpId}`, headers: { cookie: auth.cookie } });
  assert.match(dumpPage.body, /name="retentionDays"/);
  assert.match(dumpPage.body, /calculated from the server clock/);
  assert.doesNotMatch(dumpPage.body, /name="purgeAt"/);
  const invalidRetention = await server.inject({ method: "POST", url: `/dumps/${realDumpId}/retention`, headers: { cookie: auth.cookie, "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams({ csrf: auth.csrf, retentionDays: "0" }).toString() });
  assert.equal(invalidRetention.statusCode, 400);
  assert.equal(engine.snapshot().dumps[0]?.purgeAt, null);
  const retention = await server.inject({ method: "POST", url: `/dumps/${realDumpId}/retention`, headers: { cookie: auth.cookie, "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams({ csrf: auth.csrf, retentionDays: "2" }).toString() });
  assert.equal(retention.statusCode, 303);
  assert.equal(engine.snapshot().dumps[0]?.purgeAt, "2026-09-06T12:00:00.000Z");
  const invalidGrant = await server.inject({ method: "POST", url: `/cases/${caseId}/grants`, headers: { cookie: auth.cookie, "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams({ csrf: auth.csrf, hours: "24", maxBytes: "2048" }).toString() });
  const invalidUploadPath = invalidGrant.body.match(/\/upload\/[A-Za-z0-9_-]{43,128}/)?.[0];
  assert.ok(invalidUploadPath);
  const invalidDump = await server.inject({ method: "POST", url: invalidUploadPath, headers: { "content-type": "application/octet-stream" }, payload: Buffer.from("not a minidump") });
  assert.equal(invalidDump.statusCode, 201);
  assert.equal(invalidDump.json().phase, "rejected");
  const replay = await server.inject({ method: "POST", url: uploadPath, headers: { "content-type": "application/octet-stream" }, payload: Buffer.from("MDMP") });
  assert.equal(replay.statusCode, 404);
  assert.equal(engine.snapshot().dumps.length, 2);
});
