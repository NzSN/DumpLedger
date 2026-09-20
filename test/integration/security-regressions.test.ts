import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { X_SYMBOL_FILENAME_HEADER } from "@dump-ledger/http-contracts";
import { OperatorSessions, hashOperatorPassword } from "../../src/auth/sessions.js";
import { EngineHttpApplication } from "../../src/http/application.js";
import { buildHttpServer, type HttpServerOptions } from "../../src/http/server.js";
import { createVaultMinidumpInspectionPort } from "../../src/inspection/index.js";
import { EngineUploadLifecycle, EngineUploadPostProcessor, VaultUploadSink } from "../../src/intake/intake-facade.js";
import { UploadAdmission } from "../../src/intake/upload-admission.js";
import { parseSymbolArtifactId } from "../../src/domain/ids.js";
import { MemoryVault } from "../../src/vault/memory-vault.js";
import { aliasedModules } from "../fixtures/minidump/aliased-modules.js";
import { fixture } from "./support.js";

async function makeFixture(t: TestContext, overrides: Partial<HttpServerOptions> = {}) {
  const vault = new MemoryVault();
  const { engine } = fixture(createVaultMinidumpInspectionPort(vault), vault);
  const sessions = new OperatorSessions({ passwordHash: await hashOperatorPassword("review-password"), secureCookies: false });
  const application = new EngineHttpApplication(engine, vault);
  const admission = new UploadAdmission(1);
  const server = buildHttpServer({
    application, sessions,
    uploadLifecycle: new EngineUploadLifecycle(engine),
    uploadSink: new VaultUploadSink(vault),
    uploadPostProcessor: new EngineUploadPostProcessor(engine),
    uploadAdmission: admission,
    ...overrides,
  });
  t.after(async () => { server.server.closeAllConnections(); await server.close(); engine.close(); });
  const customer = engine.execute({ type: "CreateCustomer", displayName: "Test" });
  assert.ok(customer.ok && customer.customerId);
  const supportCase = engine.execute({ type: "CreateCase", customerId: customer.customerId, title: "Security regression" });
  assert.ok(supportCase.ok && supportCase.caseId);
  const issued = engine.execute({ type: "IssueGrant", caseId: supportCase.caseId, expiresAt: "2026-09-05T00:00:00.000Z", maxBytes: 1024n * 1024n, maxUploads: 3 });
  assert.ok(issued.ok && issued.grantSecret);
  return { server, engine, vault, application, admission, secret: issued.grantSecret };
}

test("amplified metadata is rejected through intake without persistence or download access", async t => {
  const { server, engine, application, secret } = await makeFixture(t);
  const response = await server.inject({
    method: "POST", url: "/api/v1/uploads",
    headers: { "content-type": "application/octet-stream", "x-upload-grant": secret },
    payload: aliasedModules("name"),
  });
  assert.equal(response.statusCode, 201);
  assert.equal(response.json().phase, "rejected");
  const dump = engine.snapshot().dumps[0];
  assert.ok(dump);
  assert.equal(dump.phase, "rejected");
  assert.equal(dump.inspectionFacts, null);
  assert.equal(application.openDownload(dump.dumpId), undefined);
});

for (const viaProxy of [true, false]) {
  test(`spoofed forwarding prefixes cannot reset login or grant limits (${viaProxy ? "trusted proxy" : "direct client"})`, async t => {
    const { server } = await makeFixture(t, { trustedProxies: ["127.0.0.1"] });
    const remoteAddress = viaProxy ? "127.0.0.1" : "192.0.2.10";
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await server.inject({
        method: "POST", url: "/api/v1/session", remoteAddress,
        headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${attempt + 1}, 192.0.2.10` },
        payload: JSON.stringify({ password: "wrong-password" }),
      });
      assert.equal(response.statusCode, attempt < 10 ? 401 : 429);
    }
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const response = await server.inject({
        method: "POST", url: "/api/v1/uploads", remoteAddress,
        headers: { "content-type": "application/octet-stream", "x-forwarded-for": `198.51.100.${attempt + 1}, 192.0.2.10` },
        payload: Buffer.from("x"),
      });
      assert.equal(response.statusCode, attempt < 30 ? 404 : 429);
    }
    // Real clients keep separate buckets; ignoring all forwarded headers
    // would pass the spoofing checks but incorrectly rate-limit the proxy.
    const otherClient = await server.inject({
      method: "POST", url: "/api/v1/session",
      remoteAddress: viaProxy ? "127.0.0.1" : "192.0.2.11",
      headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.1, 192.0.2.11" },
      payload: JSON.stringify({ password: "wrong-password" }),
    });
    assert.equal(otherClient.statusCode, 401);
  });
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "condition did not become true before deadline");
    await delay(10);
  }
}

async function startStalledRequest(server: ReturnType<typeof buildHttpServer>, path: string, headers: Record<string, string>) {
  await server.listen({ host: "127.0.0.1", port: 0 });
  const address = server.server.address();
  assert.ok(address !== null && typeof address === "object");
  const client = request({ host: "127.0.0.1", port: address.port, path, method: "POST", headers: { ...headers, "content-type": "application/octet-stream", "content-length": "100" } });
  client.on("error", () => {}); // deadline abort is expected to reset the socket
  client.on("response", response => response.resume());
  client.write(Buffer.from("x"));
  return client;
}

test("stalled HTTP dump upload cleans staging and releases admission for the next upload", async t => {
  const { server, engine, vault, admission, secret } = await makeFixture(t, { uploadTimeouts: { idleMs: 1000, totalMs: 250 } });
  const client = await startStalledRequest(server, "/api/v1/uploads", { "x-upload-grant": secret });
  t.after(() => client.destroy());
  await waitUntil(() => admission.snapshot().active === 1);
  const blocked = await server.inject({ method: "POST", url: "/api/v1/uploads", headers: { "content-type": "application/octet-stream", "x-upload-grant": secret }, payload: Buffer.from("x") });
  assert.equal(blocked.statusCode, 503);
  assert.equal(blocked.json().error.code, "upload_busy");
  await waitUntil(() => admission.snapshot().active === 0);
  await waitUntil(() => client.destroyed);
  assert.deepEqual(vault.listStagingIds(), []);
  assert.equal(engine.snapshot().dumps[0]?.phase, "rejected");
  const next = await server.inject({ method: "POST", url: "/api/v1/uploads", headers: { "content-type": "application/octet-stream", "x-upload-grant": secret }, payload: Buffer.from("x") });
  assert.equal(next.statusCode, 201);
});

test("stalled HTTP symbol ingest cleans staging without sealing an artifact", async t => {
  const token = "test-ingest-token";
  const { server, engine, vault, application } = await makeFixture(t, {
    uploadTimeouts: { idleMs: 1000, totalMs: 250 },
    ingestTokenHash: createHash("sha256").update(token).digest(),
  });
  const begun = t.mock.method(application, "beginSymbolIngest");
  const failed = t.mock.method(application, "failSymbolIngest");
  const client = await startStalledRequest(server, "/api/v1/symbols", { authorization: `Bearer ${token}`, [X_SYMBOL_FILENAME_HEADER]: Buffer.from("example.pdb").toString("base64url") });
  t.after(() => client.destroy());
  await waitUntil(() => begun.mock.calls.length === 1);
  const receipt = begun.mock.calls[0]?.result;
  assert.ok(receipt?.ok && receipt.id);
  await waitUntil(() => failed.mock.calls.length === 1);
  await waitUntil(() => client.destroyed);
  assert.deepEqual(vault.symbolPresence(parseSymbolArtifactId(receipt.id)), { staging: false, vault: false });
  assert.deepEqual(engine.listSymbolArtifacts(), []);
  const next = application.beginSymbolIngest("pdb");
  assert.ok(next.ok && next.id);
  application.failSymbolIngest(next.id);
});
