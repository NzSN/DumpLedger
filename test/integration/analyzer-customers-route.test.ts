/**
 * `GET /api/v1/customers` for the analyzer token: the customer list (id +
 * display name) is the analyzer's name-resolution surface for scoped work
 * (docs/analyzer-guide.md). Session callers keep access; wrong or absent
 * bearer tokens are the generic 401, and an unconfigured hash disables the
 * path entirely.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { decodeCustomerListResponse } from "@dump-ledger/http-contracts";
import { OperatorSessions, hashOperatorPassword } from "../../src/auth/sessions.js";
import { createDumpLedgerEngine, DeterministicClock, DeterministicEntropy, DeterministicIds } from "../../src/engine/dump-ledger-engine.js";
import { EngineHttpApplication } from "../../src/http/application.js";
import { buildHttpServer } from "../../src/http/server.js";
import { createVaultMinidumpInspectionPort } from "../../src/inspection/index.js";
import { EngineUploadLifecycle, EngineUploadPostProcessor, VaultUploadSink } from "../../src/intake/intake-facade.js";
import { MemoryVault } from "../../src/vault/memory-vault.js";

const FIXED_NOW = "2026-10-14T08:00:00.000Z";
const ANALYZER_TOKEN = `analyzer-token-${"k".repeat(40)}`;

async function makeFixture(withToken: boolean) {
  const vault = new MemoryVault();
  const engine = createDumpLedgerEngine({
    databasePath: ":memory:",
    vault,
    inspection: createVaultMinidumpInspectionPort(vault),
    grantSecretKey: Buffer.alloc(32, 0x6d),
    clock: new DeterministicClock(FIXED_NOW),
    entropy: new DeterministicEntropy(Array.from({ length: 8 }, (_u, i) => `${"a".repeat(40)}${i}`)),
    ids: new DeterministicIds(),
  });
  const sessions = new OperatorSessions({
    passwordHash: await hashOperatorPassword("local-password"),
    secureCookies: false,
  });
  const server = buildHttpServer({
    application: new EngineHttpApplication(engine, vault),
    sessions,
    uploadLifecycle: new EngineUploadLifecycle(engine),
    uploadSink: new VaultUploadSink(vault),
    uploadPostProcessor: new EngineUploadPostProcessor(engine),
    now: () => Date.parse(FIXED_NOW),
    ...(withToken
      ? { analyzerTokenHash: createHash("sha256").update(ANALYZER_TOKEN, "utf8").digest() }
      : {}),
  });
  const login = await server.inject({
    method: "POST",
    url: "/api/v1/session",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ password: "local-password" }),
  });
  assert.equal(login.statusCode, 200);
  const cookie = (login.headers["set-cookie"] as string).split(";")[0]!;
  return { server, engine, cookie };
}

test("GET /api/v1/customers: analyzer token lists id + display name", async () => {
  const fixture = await makeFixture(true);
  assert.ok(fixture.engine.execute({ type: "CreateCustomer", displayName: "Acme" }).ok);
  assert.ok(fixture.engine.execute({ type: "CreateCustomer", displayName: "Globex" }).ok);

  const response = await fixture.server.inject({
    method: "GET",
    url: "/api/v1/customers",
    headers: { authorization: `Bearer ${ANALYZER_TOKEN}` },
  });
  assert.equal(response.statusCode, 200);
  const body = decodeCustomerListResponse(response.json(), "$");
  const names = body.customers.map((c) => c.displayName).sort();
  assert.deepEqual(names, ["Acme", "Globex"]);
  assert.ok(body.customers.every((c) => c.customerId.startsWith("customer_")));
});

test("GET /api/v1/customers: session cookie still works; anonymous and wrong tokens 401", async () => {
  const fixture = await makeFixture(true);
  const session = await fixture.server.inject({
    method: "GET",
    url: "/api/v1/customers",
    headers: { cookie: fixture.cookie },
  });
  assert.equal(session.statusCode, 200);

  const anonymous = await fixture.server.inject({ method: "GET", url: "/api/v1/customers" });
  assert.equal(anonymous.statusCode, 401);

  // Pinned precedence: a wrong bearer is 401 even with a valid session cookie.
  const wrong = await fixture.server.inject({
    method: "GET",
    url: "/api/v1/customers",
    headers: { cookie: fixture.cookie, authorization: "Bearer wrong" },
  });
  assert.equal(wrong.statusCode, 401);
});

test("GET /api/v1/customers: an unconfigured analyzer hash disables the bearer path", async () => {
  const fixture = await makeFixture(false);
  const response = await fixture.server.inject({
    method: "GET",
    url: "/api/v1/customers",
    headers: { authorization: `Bearer ${ANALYZER_TOKEN}` },
  });
  assert.equal(response.statusCode, 401);
});
