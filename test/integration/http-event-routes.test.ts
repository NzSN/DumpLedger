/**
 * Analyzer audit event feed HTTP surface (docs/analyzer-integration-design.md,
 * "Event feed"; milestone AI2): `GET /api/v1/events` with its opaque
 * zero-padded rowid cursor, action/case filters, limit bounds, beyond-end
 * echo, the pinned session-or-analyzer-bearer guard precedence, and
 * malformed-parameter rejections — all through the real engine and Fastify
 * stack, seeded only by engine commands.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  decodeErrorResponse,
  decodeEventFeedResponse,
  decodeSessionResponse,
} from "@dump-ledger/http-contracts";
import { OperatorSessions, hashOperatorPassword } from "../../src/auth/sessions.js";
import type { CaseId } from "../../src/domain/ids.js";
import { createDumpLedgerEngine, DeterministicClock, DeterministicEntropy, DeterministicIds } from "../../src/engine/dump-ledger-engine.js";
import { EngineHttpApplication } from "../../src/http/application.js";
import { buildHttpServer } from "../../src/http/server.js";
import { createVaultMinidumpInspectionPort } from "../../src/inspection/index.js";
import { EngineUploadLifecycle, EngineUploadPostProcessor, VaultUploadSink } from "../../src/intake/intake-facade.js";
import { MemoryVault } from "../../src/vault/memory-vault.js";

const FIXED_NOW = "2026-09-16T08:00:00.000Z";
const EXPIRY = "2026-09-17T08:00:00.000Z";
const ANALYZER_TOKEN = `analyzer-token-${"k".repeat(40)}`;
const ANALYZER_TOKEN_HASH = createHash("sha256").update(ANALYZER_TOKEN, "utf8").digest();

function deterministicSecrets(count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => `${"a".repeat(40)}${index.toString(36).padStart(4, "0")}`);
}

interface Fixture {
  readonly server: ReturnType<typeof buildHttpServer>;
  readonly engine: ReturnType<typeof createDumpLedgerEngine>;
  readonly cookie: string;
}

/** Fresh real engine/vault/server per test; the analyzer hash is configured
 * per test because "disabled" is its own case. */
async function makeFixture(options: { readonly analyzerTokenHash?: Buffer } = {}): Promise<Fixture> {
  const vault = new MemoryVault();
  const clock = new DeterministicClock(FIXED_NOW);
  const engine = createDumpLedgerEngine({
    databasePath: ":memory:",
    vault,
    inspection: createVaultMinidumpInspectionPort(vault),
    grantSecretKey: Buffer.alloc(32, 0x6d),
    clock,
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
    uploadLifecycle: new EngineUploadLifecycle(engine),
    uploadSink: new VaultUploadSink(vault),
    uploadPostProcessor: new EngineUploadPostProcessor(engine),
    now: () => Date.parse(FIXED_NOW),
    ...(options.analyzerTokenHash === undefined ? {} : { analyzerTokenHash: options.analyzerTokenHash }),
  });
  const login = await server.inject({
    method: "POST",
    url: "/api/v1/session",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ password: "local-password" }),
  });
  assert.equal(login.statusCode, 200);
  const cookie = (login.headers["set-cookie"] as string).split(";")[0]!;
  const csrf = decodeSessionResponse(login.json(), "$").csrfToken as string;
  assert.ok(csrf.length > 0);
  return { server, engine, cookie };
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function errorCode(response: { json(): unknown }): string {
  return decodeErrorResponse(response.json(), "$").error.code;
}

function cursorFor(rowid: number): string {
  return rowid.toString(10).padStart(16, "0");
}

interface TrailEntry {
  readonly action: string;
  readonly caseId: string | null;
  readonly detail: Record<string, unknown>;
}

interface Trail {
  readonly caseA: CaseId;
  readonly caseB: CaseId;
  /** The audit rows the seeded commands must append, in trail order. */
  readonly expected: readonly TrailEntry[];
}

/** Seeds the audit trail through engine commands only: a customer, two cases,
 * the workflow on each, and one grant issuance whose detail carries a
 * non-empty payload (proves detail pass-through). */
function seedTrail(engine: ReturnType<typeof createDumpLedgerEngine>): Trail {
  const customer = engine.execute({ type: "CreateCustomer", displayName: "Acme" });
  if (!customer.ok || customer.customerId === undefined) throw new Error("seed: CreateCustomer failed");
  const caseA = engine.execute({ type: "CreateCase", customerId: customer.customerId, title: "Renderer crash" });
  if (!caseA.ok || caseA.caseId === undefined) throw new Error("seed: CreateCase A failed");
  if (!engine.execute({ type: "StartInvestigation", caseId: caseA.caseId }).ok) throw new Error("seed: StartInvestigation A failed");
  if (!engine.execute({ type: "WaitForCustomer", caseId: caseA.caseId }).ok) throw new Error("seed: WaitForCustomer A failed");
  const grant = engine.execute({ type: "IssueGrant", caseId: caseA.caseId, expiresAt: EXPIRY, maxBytes: 10_737_418_240n, maxUploads: 16 });
  if (!grant.ok || grant.grantId === undefined) throw new Error("seed: IssueGrant failed");
  const caseB = engine.execute({ type: "CreateCase", customerId: customer.customerId, title: "GPU crash" });
  if (!caseB.ok || caseB.caseId === undefined) throw new Error("seed: CreateCase B failed");
  if (!engine.execute({ type: "StartInvestigation", caseId: caseB.caseId }).ok) throw new Error("seed: StartInvestigation B failed");
  return {
    caseA: caseA.caseId,
    caseB: caseB.caseId,
    expected: [
      { action: "CreateCustomer", caseId: null, detail: {} },
      { action: "CreateCase", caseId: caseA.caseId, detail: {} },
      { action: "StartInvestigation", caseId: caseA.caseId, detail: {} },
      { action: "WaitForCustomer", caseId: caseA.caseId, detail: {} },
      { action: "IssueGrant", caseId: caseA.caseId, detail: { grantId: grant.grantId, maxUploads: 16 } },
      { action: "CreateCase", caseId: caseB.caseId, detail: {} },
      { action: "StartInvestigation", caseId: caseB.caseId, detail: {} },
    ],
  };
}

/* ------------------------------------------------------------------------ */

test("events guard precedence, scan from zero, and detail pass-through", async t => {
  const fixture = await makeFixture({ analyzerTokenHash: ANALYZER_TOKEN_HASH });
  const { server, engine, cookie } = fixture;
  t.after(async () => { await server.close(); engine.close(); });

  const trail = seedTrail(engine);

  // Anonymous: the generic 401 envelope.
  const anon = await server.inject({ method: "GET", url: "/api/v1/events" });
  assert.equal(anon.statusCode, 401);
  assert.equal(errorCode(anon), "unauthenticated");

  // Wrong token + valid session cookie: the Authorization header selects the
  // bearer path only, so the cookie never rescues it, and it is a 401 (not a
  // CSRF/forbidden signal).
  const wrongWithCookie = await server.inject({
    method: "GET", url: "/api/v1/events",
    headers: { cookie, authorization: "Bearer wrong-token" },
  });
  assert.equal(wrongWithCookie.statusCode, 401);
  assert.equal(errorCode(wrongWithCookie), "unauthenticated");

  // Malformed Authorization header + valid cookie: same 401, never a fallback.
  const malformedWithCookie = await server.inject({
    method: "GET", url: "/api/v1/events",
    headers: { cookie, authorization: "Basic dXNlcjpwYXNz" },
  });
  assert.equal(malformedWithCookie.statusCode, 401);
  assert.equal(errorCode(malformedWithCookie), "unauthenticated");

  // Session caller scans the whole trail from the beginning.
  const scan = await server.inject({ method: "GET", url: "/api/v1/events", headers: { cookie } });
  assert.equal(scan.statusCode, 200);
  const page = decodeEventFeedResponse(scan.json(), "$");
  assert.deepEqual(page.events.map(entry => entry.action), trail.expected.map(entry => entry.action));
  assert.deepEqual(page.events.map(entry => entry.caseId), trail.expected.map(entry => entry.caseId));
  page.events.forEach((entry, index) => {
    assert.equal(entry.cursor, cursorFor(index + 1));
    assert.equal(entry.occurredAt, FIXED_NOW);
    assert.ok(entry.customerId !== null, "every seeded row carries a customer");
    assert.equal(entry.dumpId, null);
    assert.deepEqual(entry.detail, trail.expected[index]?.detail);
  });
  assert.equal(page.nextCursor, cursorFor(trail.expected.length));

  // The zero cursor explicitly scans from the beginning.
  const fromZero = await server.inject({ method: "GET", url: "/api/v1/events?since=0000000000000000", headers: { cookie } });
  assert.equal(fromZero.statusCode, 200);
  assert.deepEqual(
    decodeEventFeedResponse(fromZero.json(), "$").events.map(entry => entry.cursor),
    page.events.map(entry => entry.cursor),
  );

  // A well-formed cursor beyond the end returns an empty page that echoes the
  // request position: that echo is how a caught-up poller sleeps.
  const beyond = await server.inject({ method: "GET", url: "/api/v1/events?since=9007199254740991", headers: { cookie } });
  assert.equal(beyond.statusCode, 200);
  assert.deepEqual(decodeEventFeedResponse(beyond.json(), "$"), { events: [], nextCursor: "9007199254740991" });

  // Valid analyzer token alone (no cookie, no CSRF) opens the same read.
  const tokenScan = await server.inject({ method: "GET", url: "/api/v1/events", headers: bearer(ANALYZER_TOKEN) });
  assert.equal(tokenScan.statusCode, 200);
  const tokenPage = decodeEventFeedResponse(tokenScan.json(), "$");
  assert.deepEqual(tokenPage.events, page.events);
  assert.equal(tokenPage.nextCursor, page.nextCursor);

  // Malformed parameters are invalid_request: bad cursors (non-digits, over
  // 16 digits, above Number.MAX_SAFE_INTEGER, empty, signed, fractional),
  // out-of-range limits, unknown parameters, and duplicates.
  for (const query of [
    "since=abc",
    "since=12345678901234567",
    "since=9999999999999999",
    "since=",
    "since=-1",
    "since=1.5",
    "limit=0",
    "limit=501",
    "limit=x",
    "wait=1000",
    "limit=1&limit=2",
  ]) {
    const response = await server.inject({ method: "GET", url: `/api/v1/events?${query}`, headers: { cookie } });
    assert.equal(response.statusCode, 400, `${query} must be rejected`);
    assert.equal(errorCode(response), "invalid_request", `${query} must be invalid_request`);
  }
});

test("events filters and paged continuation over interleaved writes", async t => {
  const fixture = await makeFixture({ analyzerTokenHash: ANALYZER_TOKEN_HASH });
  const { server, engine, cookie } = fixture;
  t.after(async () => { await server.close(); engine.close(); });

  const trail = seedTrail(engine);

  // caseId filter: exact case rows only (the customer-level CreateCustomer row
  // carries a null caseId and is excluded).
  const byCase = await server.inject({ method: "GET", url: `/api/v1/events?caseId=${trail.caseA}`, headers: bearer(ANALYZER_TOKEN) });
  assert.equal(byCase.statusCode, 200);
  const casePage = decodeEventFeedResponse(byCase.json(), "$");
  assert.deepEqual(casePage.events.map(entry => entry.action), ["CreateCase", "StartInvestigation", "WaitForCustomer", "IssueGrant"]);
  assert.equal(casePage.events.every(entry => entry.caseId === trail.caseA), true);
  assert.equal(casePage.events.every(entry => entry.customerId !== null), true);
  assert.equal(casePage.nextCursor, cursorFor(5));

  // actions filter alone, and combined with caseId.
  const byActions = await server.inject({ method: "GET", url: "/api/v1/events?actions=StartInvestigation", headers: { cookie } });
  assert.equal(byActions.statusCode, 200);
  assert.deepEqual(
    decodeEventFeedResponse(byActions.json(), "$").events.map(entry => entry.action),
    ["StartInvestigation", "StartInvestigation"],
  );
  const combined = await server.inject({
    method: "GET",
    url: `/api/v1/events?actions=StartInvestigation,WaitForCustomer&caseId=${trail.caseB}`,
    headers: { cookie },
  });
  assert.equal(combined.statusCode, 200);
  assert.deepEqual(
    decodeEventFeedResponse(combined.json(), "$").events.map(entry => entry.action),
    ["StartInvestigation"],
  );

  // First page with limit=2, then a write lands through the engine before the
  // continuation: the poller must pick it up without gaps or duplicates.
  const firstResponse = await server.inject({ method: "GET", url: "/api/v1/events?limit=2", headers: { cookie } });
  assert.equal(firstResponse.statusCode, 200);
  const first = decodeEventFeedResponse(firstResponse.json(), "$");
  assert.deepEqual(first.events.map(entry => entry.action), ["CreateCustomer", "CreateCase"]);
  assert.equal(first.nextCursor, first.events[1]?.cursor);
  assert.ok(engine.execute({ type: "WaitForCustomer", caseId: trail.caseB }).ok);

  const events = [...first.events];
  let cursor = first.nextCursor;
  let reachedEdge = false;
  for (let round = 0; round < 6 && !reachedEdge; round += 1) {
    const response = await server.inject({ method: "GET", url: `/api/v1/events?limit=2&since=${cursor}`, headers: { cookie } });
    assert.equal(response.statusCode, 200);
    const decoded = decodeEventFeedResponse(response.json(), "$");
    if (decoded.events.length === 0) {
      assert.equal(decoded.nextCursor, cursor, "at the live edge the page echoes the request position");
      reachedEdge = true;
    } else {
      assert.ok(decoded.events.length <= 2);
      events.push(...decoded.events);
      cursor = decoded.nextCursor;
      assert.equal(cursor, decoded.events[decoded.events.length - 1]?.cursor);
    }
  }
  assert.equal(reachedEdge, true, "paging must reach the live edge");
  assert.equal(events.length, trail.expected.length + 1);
  assert.equal(new Set(events.map(entry => entry.cursor)).size, events.length, "pages must be duplicate-free");
  assert.deepEqual(
    events.map(entry => entry.action),
    [...trail.expected.map(entry => entry.action), "WaitForCustomer"],
  );
  assert.deepEqual(
    events.map(entry => entry.cursor),
    events.map((_entry, index) => cursorFor(index + 1)),
    "pages must be gapless and in rowid order",
  );

  // Page bounds: the smallest page carries exactly one row and its cursor;
  // the 500 cap is the default-and-maximum page for a small trail.
  const single = await server.inject({ method: "GET", url: "/api/v1/events?limit=1", headers: { cookie } });
  assert.equal(single.statusCode, 200);
  const singlePage = decodeEventFeedResponse(single.json(), "$");
  assert.equal(singlePage.events.length, 1);
  assert.equal(singlePage.nextCursor, singlePage.events[0]?.cursor);
  const capped = await server.inject({ method: "GET", url: "/api/v1/events?limit=500", headers: { cookie } });
  assert.equal(capped.statusCode, 200);
  assert.equal(decodeEventFeedResponse(capped.json(), "$").events.length, 8);
});
