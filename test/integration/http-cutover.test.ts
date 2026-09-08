import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { decodeCreateCustomerResponse, decodeSessionResponse } from "@dump-ledger/http-contracts";
import { OperatorSessions, hashOperatorPassword } from "../../src/auth/sessions.js";
import { createDumpLedgerEngine, DeterministicClock, DeterministicEntropy, DeterministicIds } from "../../src/engine/dump-ledger-engine.js";
import { EngineHttpApplication } from "../../src/http/application.js";
import { buildHttpServer, type HttpServerOptions } from "../../src/http/server.js";
import { createVaultMinidumpInspectionPort } from "../../src/inspection/index.js";
import { EngineUploadLifecycle, EngineUploadPostProcessor, VaultUploadSink } from "../../src/intake/intake-facade.js";
import { MemoryVault } from "../../src/vault/memory-vault.js";

const FIXED_NOW_MS = Date.parse("2026-09-04T12:00:00.000Z");
const INDEX_BODY = "<!doctype html><html><head><meta charset=\"utf-8\"><title>DumpLedger fixture</title></head><body><div id=\"root\"></div></body></html>";
const ASSET_JS = "export const marker = 'fixture-asset';";

/** Writes a deterministic mini web build into a fresh temp dir and returns its root. */
function webFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "dump-ledger-web-"));
  writeFileSync(join(root, "index.html"), INDEX_BODY);
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "assets", "index-abc123.js"), ASSET_JS);
  writeFileSync(join(root, "assets", "index-abc123.css"), "body { color: #fff; }");
  return root;
}

async function makeFixture(overrides: Partial<HttpServerOptions> = {}) {
  const webRoot = webFixture();
  const vault = new MemoryVault();
  const engine = createDumpLedgerEngine({
    databasePath: ":memory:",
    vault,
    inspection: createVaultMinidumpInspectionPort(vault),
    grantSecretKey: Buffer.alloc(32, 0x5a),
    clock: new DeterministicClock("2026-09-04T12:00:00.000Z"),
    entropy: new DeterministicEntropy(["s".repeat(40) + "0000", "s".repeat(40) + "0001"]),
    ids: new DeterministicIds(),
  });
  const sessions = new OperatorSessions({ passwordHash: await hashOperatorPassword("local-password"), secureCookies: false });
  const server = buildHttpServer({
    application: new EngineHttpApplication(engine, vault),
    sessions,
    uploadLifecycle: new EngineUploadLifecycle(engine),
    uploadSink: new VaultUploadSink(vault),
    uploadPostProcessor: new EngineUploadPostProcessor(engine),
    now: () => FIXED_NOW_MS,
    webRoot,
    ...overrides,
  });
  const cleanup = () => {
    server.close();
    engine.close();
    rmSync(webRoot, { recursive: true, force: true });
  };
  return { server, webRoot, cleanup };
}

async function loginJson(server: ReturnType<typeof buildHttpServer>): Promise<{ cookie: string; csrf: string }> {
  const response = await server.inject({
    method: "POST",
    url: "/api/v1/session",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ password: "local-password" }),
  });
  assert.equal(response.statusCode, 200);
  decodeSessionResponse(response.json(), "$");
  const setCookie = response.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";", 1)[0];
  assert.ok(cookie);
  return { cookie, csrf: response.json().csrfToken as string };
}

const FULL_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

test("the React shell is served at every final browser route with security headers", async t => {
  const { server, cleanup } = await makeFixture();
  t.after(cleanup);
  const browserRoutes = ["/", "/login", "/upload", "/customers", "/cases", "/dumps", "/operations", "/cases/case-1", "/dumps/dump-1"];
  for (const route of browserRoutes) {
    const response = await server.inject({ method: "GET", url: route });
    assert.equal(response.statusCode, 200, `${route} should serve the shell`);
    assert.equal(response.headers["content-type"], "text/html; charset=utf-8");
    assert.match(response.body, /<div id="root"><\/div>/);
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["content-security-policy"], FULL_CSP);
    assert.equal(response.headers["x-frame-options"], "DENY");
    assert.equal(response.headers["referrer-policy"], "no-referrer");
    assert.equal(response.headers["x-content-type-options"], "nosniff");
  }
});

test("hashed assets are immutable and content-typed; unknown assets are JSON 404", async t => {
  const { server, cleanup } = await makeFixture();
  t.after(cleanup);
  const js = await server.inject({ method: "GET", url: "/assets/index-abc123.js" });
  assert.equal(js.statusCode, 200);
  assert.equal(js.body, ASSET_JS);
  assert.equal(js.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.equal(js.headers["content-type"], "text/javascript; charset=utf-8");
  const css = await server.inject({ method: "GET", url: "/assets/index-abc123.css" });
  assert.equal(css.statusCode, 200);
  assert.equal(css.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.equal(css.headers["content-type"], "text/css; charset=utf-8");

  const missing = await server.inject({ method: "GET", url: "/assets/index-nope.js" });
  assert.equal(missing.statusCode, 404);
  assert.match(missing.headers["content-type"] ?? "", /application\/json/);
  assert.doesNotMatch(missing.body, /<html|<!doctype/i);

  // Legacy asset routes and traversal-shaped names are gone / rejected.
  for (const legacy of ["/assets/app.css", "/assets/app.js", "/assets/upload.js", "/assets/.hidden.js"]) {
    const response = await server.inject({ method: "GET", url: legacy });
    assert.equal(response.statusCode, 404, `${legacy} must not be served`);
    assert.doesNotMatch(response.body, /<html|<!doctype/i);
  }
});

test("unknown /api and /health paths stay JSON and are never turned into HTML", async t => {
  const { server, cleanup } = await makeFixture();
  t.after(cleanup);
  const probes = [
    { method: "GET", url: "/api/v1/nope" },
    { method: "POST", url: "/api/v1/nope" },
    { method: "GET", url: "/health/extra" },
    { method: "GET", url: "/api" },
  ];
  for (const probe of probes) {
    const response = await server.inject({ method: probe.method as "GET", url: probe.url });
    assert.equal(response.statusCode, 404, `${probe.method} ${probe.url}`);
    assert.match(response.headers["content-type"] ?? "", /application\/json/);
    assert.doesNotMatch(response.body, /<html|<!doctype/i);
  }
});

test("deleted legacy HTML routes and path-secret uploader are unreachable", async t => {
  const { server, cleanup } = await makeFixture();
  t.after(cleanup);
  const secret = "s".repeat(40) + "0000";
  const probes = [
    { method: "GET", url: `/upload/${secret}` },
    { method: "POST", url: `/upload/${secret}`, headers: { "content-type": "application/octet-stream" }, payload: Buffer.from("MDMP") },
    { method: "POST", url: "/upload", headers: { "content-type": "application/octet-stream" }, payload: Buffer.from("MDMP") },
    { method: "GET", url: "/operations/health" },
    { method: "GET", url: "/dumps/dump-1/download" },
    { method: "GET", url: "/cases/case-1/manifest.json" },
    { method: "GET", url: "/nonsense" },
    { method: "GET", url: "/cases/case-1/extra-segment" },
    { method: "GET", url: "/customers/customer-1" },
  ];
  for (const probe of probes) {
    const options: Record<string, unknown> = { method: probe.method as "GET", url: probe.url };
    if (probe.headers !== undefined) options.headers = probe.headers;
    if (probe.payload !== undefined) options.payload = probe.payload;
    const response = await server.inject(options);
    assert.equal(response.statusCode, 404, `${probe.method} ${probe.url} must be gone`);
    assert.doesNotMatch(response.body, /<html|<!doctype/i, `${probe.url} must not become HTML`);
  }
  // A POST to the deleted path-secret uploader must never be treated as a
  // browser navigation; it stays a JSON-ish 404.
  const post = await server.inject({ method: "POST", url: "/upload/anything", headers: { "content-type": "application/octet-stream" }, payload: Buffer.from("x") });
  assert.equal(post.statusCode, 404);
  assert.doesNotMatch(post.body, /<html|<!doctype/i);
});

test("a missing web build fails closed with JSON 404 rather than HTML", async t => {
  const { server, cleanup } = await makeFixture({ webRoot: join(tmpdir(), "dump-ledger-does-not-exist-" + Date.now()) });
  t.after(cleanup);
  const index = await server.inject({ method: "GET", url: "/login" });
  assert.equal(index.statusCode, 404);
  assert.doesNotMatch(index.body, /<html|<!doctype/i);
  const asset = await server.inject({ method: "GET", url: "/assets/index-abc123.js" });
  assert.equal(asset.statusCode, 404);
  assert.doesNotMatch(asset.body, /<html|<!doctype/i);
});

test("authenticated mutations accept same-origin and configured dev origins", async t => {
  const { server, cleanup } = await makeFixture({ allowedOrigins: ["http://127.0.0.1:5173"] });
  t.after(cleanup);
  const auth = await loginJson(server);
  const headers = { cookie: auth.cookie, "content-type": "application/json", "x-csrf-token": auth.csrf, host: "127.0.0.1:4080" };
  const body = JSON.stringify({ displayName: "Acme" });

  const sameOrigin = await server.inject({ method: "POST", url: "/api/v1/customers", headers: { ...headers, origin: "http://127.0.0.1:4080" }, payload: body });
  assert.equal(sameOrigin.statusCode, 201);
  decodeCreateCustomerResponse(sameOrigin.json(), "$");

  const devOrigin = await server.inject({ method: "POST", url: "/api/v1/customers", headers: { ...headers, origin: "http://127.0.0.1:5173" }, payload: body });
  assert.equal(devOrigin.statusCode, 201);
  decodeCreateCustomerResponse(devOrigin.json(), "$");
});

test("authenticated mutations reject foreign origins and cross-site fetch metadata", async t => {
  const { server, cleanup } = await makeFixture();
  t.after(cleanup);
  const auth = await loginJson(server);
  const headers = { cookie: auth.cookie, "content-type": "application/json", "x-csrf-token": auth.csrf, host: "127.0.0.1:4080" };
  const body = JSON.stringify({ displayName: "Acme" });

  const foreignOrigin = await server.inject({ method: "POST", url: "/api/v1/customers", headers: { ...headers, origin: "http://evil.example" }, payload: body });
  assert.equal(foreignOrigin.statusCode, 403);
  assert.deepEqual(foreignOrigin.json().error, { code: "forbidden", message: "Forbidden.", retryable: false });

  const crossSite = await server.inject({ method: "POST", url: "/api/v1/customers", headers: { ...headers, "sec-fetch-site": "cross-site" }, payload: body });
  assert.equal(crossSite.statusCode, 403);

  const sameSite = await server.inject({ method: "POST", url: "/api/v1/customers", headers: { ...headers, "sec-fetch-site": "same-origin" }, payload: body });
  assert.equal(sameSite.statusCode, 201);

  // A 403 must not invalidate the session: a clean (no Origin header) request still works.
  const after = await server.inject({ method: "POST", url: "/api/v1/customers", headers: { cookie: auth.cookie, "content-type": "application/json", "x-csrf-token": auth.csrf }, payload: body });
  assert.equal(after.statusCode, 201);
});

test("authenticated mutations accept the browser HTTPS origin behind a trusted TLS proxy", async t => {
  const { server, cleanup } = await makeFixture({ trustProxy: true });
  t.after(cleanup);
  const auth = await loginJson(server);
  const headers = { cookie: auth.cookie, "content-type": "application/json", "x-csrf-token": auth.csrf, host: "ledger.example" };
  const body = JSON.stringify({ displayName: "Acme" });

  // Production topology: the proxy terminates TLS and forwards over loopback
  // HTTP with X-Forwarded-Proto; the browser Origin stays https. The origin
  // check must compare against the forwarded protocol, not the socket's.
  const proxied = await server.inject({ method: "POST", url: "/api/v1/customers", headers: { ...headers, origin: "https://ledger.example", "x-forwarded-proto": "https" }, payload: body });
  assert.equal(proxied.statusCode, 201);
  decodeCreateCustomerResponse(proxied.json(), "$");

  // Without the proxy's forwarded-proto evidence the https origin does not
  // match the plain-HTTP request, so the mutation stays rejected.
  const unforwarded = await server.inject({ method: "POST", url: "/api/v1/customers", headers: { ...headers, origin: "https://ledger.example" }, payload: body });
  assert.equal(unforwarded.statusCode, 403);
});

test("authenticated mutations keep rejecting foreign origins behind a trusted proxy", async t => {
  const { server, cleanup } = await makeFixture({ trustProxy: true });
  t.after(cleanup);
  const auth = await loginJson(server);
  const headers = { cookie: auth.cookie, "content-type": "application/json", "x-csrf-token": auth.csrf, host: "ledger.example" };
  const body = JSON.stringify({ displayName: "Acme" });

  const foreignOrigin = await server.inject({ method: "POST", url: "/api/v1/customers", headers: { ...headers, origin: "https://evil.example", "x-forwarded-proto": "https" }, payload: body });
  assert.equal(foreignOrigin.statusCode, 403);

  // A spoofed protocol downgrade does not help an https attacker origin either.
  const downgrade = await server.inject({ method: "POST", url: "/api/v1/customers", headers: { ...headers, origin: "https://ledger.example", "x-forwarded-proto": "http" }, payload: body });
  assert.equal(downgrade.statusCode, 403);
});

test("the upload header path still streams without Origin checks (public bearer transport)", async t => {
  const { server, cleanup } = await makeFixture();
  t.after(cleanup);
  // Reaching /api/v1/uploads requires a live grant; this fixture's engine has
  // none, so the request must fail with the stable grant error and never with
  // an origin/CSRF error, proving the public uploader is not cookie-gated.
  const response = await server.inject({
    method: "POST",
    url: "/api/v1/uploads",
    headers: { "content-type": "application/octet-stream", "x-upload-grant": "missing-grant-secret-that-does-not-exist-123456" },
    payload: Buffer.from("MDMP"),
  });
  assert.equal(response.statusCode, 404);
  assert.deepEqual(response.json().error, { code: "grant_unavailable", message: "The upload grant is unavailable.", retryable: false });
});
