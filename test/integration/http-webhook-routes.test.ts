/**
 * Webhook management API (docs/webhook-notifications-design.md, "Management
 * API"; milestones WH1 and WH2): full CRUD through the real Fastify stack, the
 * operator-session boundary (analyzer bearer rejected), the webhook-admin
 * bearer path with pinned precedence and no CSRF/Origin evidence,
 * URL/filter/case validation, secret-once semantics, live-edge cursors, and
 * cascade-on-delete.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  CSRF_HEADER,
  MAX_WEBHOOK_URL_LENGTH,
  decodeCreateWebhookResponse,
  decodeErrorResponse,
  decodeSessionResponse,
  decodeWebhookDeliveriesResponse,
  decodeWebhookListResponse,
} from "@dump-ledger/http-contracts";
import { OperatorSessions, hashOperatorPassword } from "../../src/auth/sessions.js";
import { createDumpLedgerEngine, DeterministicClock, DeterministicEntropy, DeterministicIds } from "../../src/engine/dump-ledger-engine.js";
import { EngineHttpApplication } from "../../src/http/application.js";
import { buildHttpServer } from "../../src/http/server.js";
import { createVaultMinidumpInspectionPort } from "../../src/inspection/index.js";
import { EngineUploadLifecycle, EngineUploadPostProcessor, VaultUploadSink } from "../../src/intake/intake-facade.js";
import { MemoryVault } from "../../src/vault/memory-vault.js";

const FIXED_NOW = "2026-09-16T08:00:00.000Z";
const ANALYZER_TOKEN = `analyzer-token-${"w".repeat(40)}`;
const ANALYZER_TOKEN_HASH = createHash("sha256").update(ANALYZER_TOKEN, "utf8").digest();
const WEBHOOK_ADMIN_TOKEN = `webhook-admin-token-${"v".repeat(40)}`;
const WEBHOOK_ADMIN_TOKEN_HASH = createHash("sha256").update(WEBHOOK_ADMIN_TOKEN, "utf8").digest();
const HOOK_URL = "http://127.0.0.1:9099/analyzer";

function deterministicSecrets(count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => `${"a".repeat(40)}${index.toString(36).padStart(4, "0")}`);
}

interface Fixture {
  readonly server: ReturnType<typeof buildHttpServer>;
  readonly engine: ReturnType<typeof createDumpLedgerEngine>;
  readonly cookie: string;
  readonly csrf: string;
}

/** Fresh real engine/vault/server per test, with the analyzer bearer token and
 * the webhook-admin token configured so both bearer boundaries are exercised
 * against usable credentials rather than disabled paths. Pass `null` to
 * leave the webhook-admin bearer path disabled. */
async function makeFixture(webhookAdminTokenHash: Buffer | null = WEBHOOK_ADMIN_TOKEN_HASH): Promise<Fixture> {
  const vault = new MemoryVault();
  const engine = createDumpLedgerEngine({
    databasePath: ":memory:",
    vault,
    inspection: createVaultMinidumpInspectionPort(vault),
    grantSecretKey: Buffer.alloc(32, 0x6d),
    clock: new DeterministicClock(FIXED_NOW),
    entropy: new DeterministicEntropy(deterministicSecrets(16)),
    ids: new DeterministicIds(),
  });
  const sessions = new OperatorSessions({
    passwordHash: await hashOperatorPassword("local-password"),
    secureCookies: false,
  });
  const server = buildHttpServer({
    application: new EngineHttpApplication(engine, vault),
    sessions,
    analyzerTokenHash: ANALYZER_TOKEN_HASH,
    ...(webhookAdminTokenHash === null ? {} : { webhookAdminTokenHash }),
    uploadLifecycle: new EngineUploadLifecycle(engine),
    uploadSink: new VaultUploadSink(vault),
    uploadPostProcessor: new EngineUploadPostProcessor(engine),
    now: () => Date.parse(FIXED_NOW),
  });
  const login = await server.inject({
    method: "POST",
    url: "/api/v1/session",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ password: "local-password" }),
  });
  assert.equal(login.statusCode, 200);
  const session = decodeSessionResponse(login.json(), "$");
  assert.ok(session.csrfToken !== undefined);
  const cookie = (login.headers["set-cookie"] as string).split(";")[0]!;
  return { server, engine, cookie, csrf: session.csrfToken };
}

function mutationHeaders(fixture: Fixture): Record<string, string> {
  return { cookie: fixture.cookie, [CSRF_HEADER]: fixture.csrf, "content-type": "application/json" };
}

function createWebhook(fixture: Fixture, body: unknown) {
  return fixture.server.inject({
    method: "POST",
    url: "/api/v1/webhooks",
    headers: mutationHeaders(fixture),
    payload: JSON.stringify(body),
  });
}

function bearer(): Record<string, string> {
  return { authorization: `Bearer ${ANALYZER_TOKEN}` };
}

function adminBearer(): Record<string, string> {
  return { authorization: `Bearer ${WEBHOOK_ADMIN_TOKEN}` };
}

function errorCode(response: { json(): unknown }): string {
  return decodeErrorResponse(response.json(), "$").error.code;
}

function cursorFor(rowid: number): string {
  return rowid.toString(10).padStart(16, "0");
}

test("webhook routes reject anonymous and analyzer bearers; session mutations need CSRF", async t => {
  const fixture = await makeFixture();
  t.after(async () => { await fixture.server.close(); fixture.engine.close(); });

  const anonymous = await fixture.server.inject({ method: "GET", url: "/api/v1/webhooks" });
  assert.equal(anonymous.statusCode, 401);
  assert.equal(errorCode(anonymous), "unauthenticated");

  // The analyzer token is a real credential for its own routes, but every
  // webhook route rejects it (see docs/webhook-admin-token-design.md, "Why
  // not the analyzer token"): a subscription pushes event data to an
  // arbitrary URL, so registration is an operator-class privilege with its
  // own independently rotatable credential.
  const bearerList = await fixture.server.inject({ method: "GET", url: "/api/v1/webhooks", headers: bearer() });
  assert.equal(bearerList.statusCode, 401);
  assert.equal(errorCode(bearerList), "unauthenticated");

  const bearerCreate = await fixture.server.inject({
    method: "POST",
    url: "/api/v1/webhooks",
    headers: { ...bearer(), "content-type": "application/json" },
    payload: JSON.stringify({ url: HOOK_URL }),
  });
  assert.equal(bearerCreate.statusCode, 401);
  assert.equal(errorCode(bearerCreate), "unauthenticated");

  const bearerDeliveries = await fixture.server.inject({
    method: "GET",
    url: "/api/v1/webhooks/whs_missing/deliveries",
    headers: bearer(),
  });
  assert.equal(bearerDeliveries.statusCode, 401);

  const bearerDelete = await fixture.server.inject({
    method: "DELETE",
    url: "/api/v1/webhooks/whs_missing",
    headers: bearer(),
  });
  assert.equal(bearerDelete.statusCode, 401);

  // Session without CSRF evidence and with a wrong token: 403, never a
  // created subscription.
  const noCsrf = await fixture.server.inject({
    method: "POST",
    url: "/api/v1/webhooks",
    headers: { cookie: fixture.cookie, "content-type": "application/json" },
    payload: JSON.stringify({ url: HOOK_URL }),
  });
  assert.equal(noCsrf.statusCode, 403);
  assert.equal(errorCode(noCsrf), "forbidden");
  const wrongCsrf = await fixture.server.inject({
    method: "POST",
    url: "/api/v1/webhooks",
    headers: { cookie: fixture.cookie, [CSRF_HEADER]: "wrong-token", "content-type": "application/json" },
    payload: JSON.stringify({ url: HOOK_URL }),
  });
  assert.equal(wrongCsrf.statusCode, 403);
  assert.equal(fixture.engine.webhookStorage().listSubscriptions().length, 0);

  const list = await fixture.server.inject({ method: "GET", url: "/api/v1/webhooks", headers: { cookie: fixture.cookie } });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(decodeWebhookListResponse(list.json(), "$").subscriptions, []);

  const missingDelete = await fixture.server.inject({
    method: "DELETE",
    url: "/api/v1/webhooks/whs_missing",
    headers: mutationHeaders(fixture),
  });
  assert.equal(missingDelete.statusCode, 404);
  assert.equal(errorCode(missingDelete), "not_found");
});

test("create returns the secret once and list never carries it", async t => {
  const fixture = await makeFixture();
  t.after(async () => { await fixture.server.close(); fixture.engine.close(); });

  const created = await createWebhook(fixture, { url: HOOK_URL, actions: ["AcceptDump"] });
  assert.equal(created.statusCode, 201);
  const body = decodeCreateWebhookResponse(created.json(), "$");
  assert.match(body.secret, /^whsec_[A-Za-z0-9_-]{43}$/);
  assert.match(body.subscription.id, /^whs_[A-Za-z0-9_-]{22}$/);
  assert.equal(body.subscription.url, HOOK_URL);
  assert.deepEqual(body.subscription.actions, ["AcceptDump"]);
  assert.equal(body.subscription.caseId, null);
  // No audit rows exist yet, so a new subscription starts at the live edge 0.
  assert.equal(body.subscription.cursor, cursorFor(0));
  assert.equal(body.subscription.createdAt, new Date(Date.parse(body.subscription.createdAt)).toISOString());

  const listed = await fixture.server.inject({ method: "GET", url: "/api/v1/webhooks", headers: { cookie: fixture.cookie } });
  assert.equal(listed.statusCode, 200);
  const subscriptions = decodeWebhookListResponse(listed.json(), "$").subscriptions;
  assert.equal(subscriptions.length, 1);
  assert.deepEqual(subscriptions[0], body.subscription);
  // The decoder rejects unknown keys, so a leaked secret would fail this
  // decode anyway; the raw-body check makes the intent explicit.
  assert.equal(listed.body.includes(body.secret), false);

  const deliveries = await fixture.server.inject({
    method: "GET",
    url: `/api/v1/webhooks/${body.subscription.id}/deliveries`,
    headers: { cookie: fixture.cookie },
  });
  assert.equal(deliveries.statusCode, 200);
  assert.deepEqual(decodeWebhookDeliveriesResponse(deliveries.json(), "$").deliveries, []);
});

test("create validates the URL, filter bounds, and case existence", async t => {
  const fixture = await makeFixture();
  t.after(async () => { await fixture.server.close(); fixture.engine.close(); });

  const invalidBodies: readonly unknown[] = [
    { url: "ftp://127.0.0.1/analyzer" },
    { url: "http://operator:secret@127.0.0.1/analyzer" },
    { url: `http://127.0.0.1/${"x".repeat(MAX_WEBHOOK_URL_LENGTH)}` },
    { url: HOOK_URL, actions: Array.from({ length: 33 }, (_unused, index) => `action-${index}`) },
    { url: HOOK_URL, actions: ["x".repeat(65)] },
    { url: HOOK_URL, caseId: "not-a-case" },
    { url: HOOK_URL, caseId: `case_${"0".repeat(26)}` },
  ];
  for (const body of invalidBodies) {
    const response = await createWebhook(fixture, body);
    assert.equal(response.statusCode, 400, `expected rejection for ${JSON.stringify(body)}`);
    assert.equal(errorCode(response), "invalid_request");
  }
  const malformed = await fixture.server.inject({
    method: "POST",
    url: "/api/v1/webhooks",
    headers: mutationHeaders(fixture),
    payload: "{not-json",
  });
  assert.equal(malformed.statusCode, 400);
  assert.equal(errorCode(malformed), "invalid_request");
  assert.equal(fixture.engine.webhookStorage().listSubscriptions().length, 0);

  const customer = fixture.engine.execute({ type: "CreateCustomer", displayName: "Acme" });
  assert.ok(customer.ok && customer.customerId !== undefined);
  const createdCase = fixture.engine.execute({ type: "CreateCase", customerId: customer.customerId, title: "Renderer crash" });
  assert.ok(createdCase.ok && createdCase.caseId !== undefined);
  const edge = fixture.engine.webhookStorage().auditLiveEdge();

  const scoped = await createWebhook(fixture, {
    url: HOOK_URL,
    actions: ["AcceptDump", "RejectDump"],
    caseId: createdCase.caseId,
  });
  assert.equal(scoped.statusCode, 201);
  const subscription = decodeCreateWebhookResponse(scoped.json(), "$").subscription;
  assert.deepEqual(subscription.actions, ["AcceptDump", "RejectDump"]);
  assert.equal(subscription.caseId, createdCase.caseId);
  // Creation is configuration, not a ledger command: the cursor is exactly
  // the audit live edge after the seeded customer+case events (rowid 2).
  assert.equal(subscription.cursor, cursorFor(edge));
  assert.equal(edge, 2);
});

test("delete removes the subscription and cascades delivery rows", async t => {
  const fixture = await makeFixture();
  t.after(async () => { await fixture.server.close(); fixture.engine.close(); });

  const created = await createWebhook(fixture, { url: HOOK_URL });
  assert.equal(created.statusCode, 201);
  const subscription = decodeCreateWebhookResponse(created.json(), "$").subscription;
  const storage = fixture.engine.webhookStorage();
  storage.createDelivery({
    deliveryId: "whd_manual",
    subscriptionId: subscription.id,
    eventRowid: 1,
    action: "AcceptDump",
    dumpId: null,
    createdAt: FIXED_NOW,
  });

  const deliveries = await fixture.server.inject({
    method: "GET",
    url: `/api/v1/webhooks/${subscription.id}/deliveries`,
    headers: { cookie: fixture.cookie },
  });
  assert.equal(deliveries.statusCode, 200);
  const rows = decodeWebhookDeliveriesResponse(deliveries.json(), "$").deliveries;
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.eventCursor, cursorFor(1));
  assert.equal(rows[0]?.status, "pending");
  assert.equal(rows[0]?.attempts, 0);

  const deleted = await fixture.server.inject({
    method: "DELETE",
    url: `/api/v1/webhooks/${subscription.id}`,
    headers: mutationHeaders(fixture),
  });
  assert.equal(deleted.statusCode, 204);
  assert.equal(deleted.body, "");
  assert.equal(storage.findSubscription(subscription.id), null);
  assert.equal(storage.findDelivery(subscription.id, 1), null);

  const afterDelete = await fixture.server.inject({ method: "GET", url: "/api/v1/webhooks", headers: { cookie: fixture.cookie } });
  assert.equal(afterDelete.statusCode, 200);
  assert.deepEqual(decodeWebhookListResponse(afterDelete.json(), "$").subscriptions, []);

  const deliveriesGone = await fixture.server.inject({
    method: "GET",
    url: `/api/v1/webhooks/${subscription.id}/deliveries`,
    headers: { cookie: fixture.cookie },
  });
  assert.equal(deliveriesGone.statusCode, 404);
  assert.equal(errorCode(deliveriesGone), "not_found");

  const secondDelete = await fixture.server.inject({
    method: "DELETE",
    url: `/api/v1/webhooks/${subscription.id}`,
    headers: mutationHeaders(fixture),
  });
  assert.equal(secondDelete.statusCode, 404);
});

test("webhook-admin bearer performs CRUD with no CSRF, cookie, or Origin evidence", async t => {
  const fixture = await makeFixture();
  t.after(async () => { await fixture.server.close(); fixture.engine.close(); });

  const listBefore = await fixture.server.inject({ method: "GET", url: "/api/v1/webhooks", headers: adminBearer() });
  assert.equal(listBefore.statusCode, 200);
  assert.deepEqual(decodeWebhookListResponse(listBefore.json(), "$").subscriptions, []);

  // Deliberately hostile browser evidence (no cookie, no CSRF header, a
  // cross-site Origin and Fetch Metadata) proves the bearer path checks none
  // of it: a machine caller has no ambient browser authority.
  const created = await fixture.server.inject({
    method: "POST",
    url: "/api/v1/webhooks",
    headers: {
      ...adminBearer(),
      "content-type": "application/json",
      origin: "https://cross-site.example",
      "sec-fetch-site": "cross-site",
    },
    payload: JSON.stringify({ url: HOOK_URL, actions: ["AcceptDump"] }),
  });
  assert.equal(created.statusCode, 201);
  const body = decodeCreateWebhookResponse(created.json(), "$");
  assert.equal(body.subscription.url, HOOK_URL);
  assert.deepEqual(body.subscription.actions, ["AcceptDump"]);

  const listed = await fixture.server.inject({ method: "GET", url: "/api/v1/webhooks", headers: adminBearer() });
  assert.equal(listed.statusCode, 200);
  const subscriptions = decodeWebhookListResponse(listed.json(), "$").subscriptions;
  assert.equal(subscriptions.length, 1);
  assert.deepEqual(subscriptions[0], body.subscription);

  const deliveries = await fixture.server.inject({
    method: "GET",
    url: `/api/v1/webhooks/${body.subscription.id}/deliveries`,
    headers: adminBearer(),
  });
  assert.equal(deliveries.statusCode, 200);
  assert.deepEqual(decodeWebhookDeliveriesResponse(deliveries.json(), "$").deliveries, []);

  const deleted = await fixture.server.inject({
    method: "DELETE",
    url: `/api/v1/webhooks/${body.subscription.id}`,
    headers: adminBearer(),
  });
  assert.equal(deleted.statusCode, 204);
  assert.equal(deleted.body, "");
  assert.equal(fixture.engine.webhookStorage().findSubscription(body.subscription.id), null);
});

test("an unusable Authorization header is 401 even with a valid session cookie", async t => {
  const fixture = await makeFixture();
  t.after(async () => { await fixture.server.close(); fixture.engine.close(); });

  const hostileHeaders: readonly Record<string, string>[] = [
    { authorization: "Bearer not-the-admin-token" },
    { authorization: "Bearer" },
    { authorization: `Basic ${WEBHOOK_ADMIN_TOKEN}` },
  ];
  for (const headers of hostileHeaders) {
    const list = await fixture.server.inject({
      method: "GET",
      url: "/api/v1/webhooks",
      headers: { cookie: fixture.cookie, ...headers },
    });
    assert.equal(list.statusCode, 401, `expected 401 for ${JSON.stringify(headers)}`);
    assert.equal(errorCode(list), "unauthenticated");

    const created = await fixture.server.inject({
      method: "POST",
      url: "/api/v1/webhooks",
      headers: { ...mutationHeaders(fixture), ...headers },
      payload: JSON.stringify({ url: HOOK_URL }),
    });
    assert.equal(created.statusCode, 401, `expected 401 for ${JSON.stringify(headers)}`);
    assert.equal(errorCode(created), "unauthenticated");

    const deleted = await fixture.server.inject({
      method: "DELETE",
      url: "/api/v1/webhooks/whs_missing",
      headers: { ...mutationHeaders(fixture), ...headers },
    });
    assert.equal(deleted.statusCode, 401);

    const deliveries = await fixture.server.inject({
      method: "GET",
      url: "/api/v1/webhooks/whs_missing/deliveries",
      headers: { cookie: fixture.cookie, ...headers },
    });
    assert.equal(deliveries.statusCode, 401);
  }
  // Pinned precedence means no request reached the application: nothing was
  // created, and the delete never resolved the unknown id to a 404 first.
  assert.equal(fixture.engine.webhookStorage().listSubscriptions().length, 0);
});

test("disabled webhook-admin configuration rejects every Authorization header without fall-through", async t => {
  const fixture = await makeFixture(null);
  t.after(async () => { await fixture.server.close(); fixture.engine.close(); });

  const bearerList = await fixture.server.inject({ method: "GET", url: "/api/v1/webhooks", headers: adminBearer() });
  assert.equal(bearerList.statusCode, 401);
  assert.equal(errorCode(bearerList), "unauthenticated");

  // Not even a valid session cookie may rescue a request that carries an
  // Authorization header while the token configuration is absent.
  const bearerWithCookie = await fixture.server.inject({
    method: "GET",
    url: "/api/v1/webhooks",
    headers: { cookie: fixture.cookie, ...adminBearer() },
  });
  assert.equal(bearerWithCookie.statusCode, 401);
  assert.equal(errorCode(bearerWithCookie), "unauthenticated");

  const sessionList = await fixture.server.inject({ method: "GET", url: "/api/v1/webhooks", headers: { cookie: fixture.cookie } });
  assert.equal(sessionList.statusCode, 200);
});
