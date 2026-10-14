/**
 * Analyzer catalog HTTP surface (docs/analyzer-integration-design.md,
 * milestone AI1): `GET /api/v1/dumps` with filters and its opaque keyset
 * cursor, `GET /api/v1/dumps/by-sha256/:sha256`, the pinned
 * session-or-analyzer-bearer guard precedence, and the content ETag/304
 * validator — all through the real engine, vault, and Fastify stack.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  MAX_CATALOG_PAGE,
  X_SYMBOL_FILENAME_HEADER,
  decodeCaseSummary,
  decodeCreateCustomerResponse,
  decodeCreateGrantResponse,
  decodeDumpCatalogResponse,
  decodeDumpDetailResponse,
  decodeErrorResponse,
  decodeSessionResponse,
  decodeSymbolListResponse,
  decodeUploadCompleteResponse,
  encodeFilenameBase64url,
  encodeSymbolFilenameBase64url,
  parseUploadFragment,
} from "@dump-ledger/http-contracts";
import { OperatorSessions, hashOperatorPassword } from "../../src/auth/sessions.js";
import { createDumpLedgerEngine, DeterministicClock, DeterministicEntropy, DeterministicIds } from "../../src/engine/dump-ledger-engine.js";
import { EngineHttpApplication } from "../../src/http/application.js";
import { buildHttpServer } from "../../src/http/server.js";
import { createVaultMinidumpInspectionPort } from "../../src/inspection/index.js";
import { EngineUploadLifecycle, EngineUploadPostProcessor, VaultUploadSink } from "../../src/intake/intake-facade.js";
import { MemoryVault } from "../../src/vault/memory-vault.js";
import { syntheticMinidump } from "../fixtures/minidump/synthetic-minidump.js";

const FIXED_NOW = "2026-09-16T08:00:00.000Z";
const ANALYZER_TOKEN = `analyzer-token-${"k".repeat(40)}`;
const ANALYZER_TOKEN_HASH = createHash("sha256").update(ANALYZER_TOKEN, "utf8").digest();

function deterministicSecrets(count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => `${"a".repeat(40)}${index.toString(36).padStart(4, "0")}`);
}

interface Fixture {
  readonly server: ReturnType<typeof buildHttpServer>;
  readonly engine: ReturnType<typeof createDumpLedgerEngine>;
  readonly clock: DeterministicClock;
  readonly cookie: string;
  readonly csrf: string;
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
  return { server, engine, clock, cookie, csrf };
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function mutationHeaders(fixture: Fixture): Record<string, string> {
  return { cookie: fixture.cookie, "content-type": "application/json", "x-csrf-token": fixture.csrf };
}

function errorCode(response: { json(): unknown }): string {
  return decodeErrorResponse(response.json(), "$").error.code;
}

/** Customer -> case -> StartInvestigation over HTTP, returning the case id. */
async function createCaseOverHttp(fixture: Fixture): Promise<string> {
  const customerResponse = await fixture.server.inject({
    method: "POST",
    url: "/api/v1/customers",
    headers: mutationHeaders(fixture),
    payload: JSON.stringify({ displayName: "Acme" }),
  });
  assert.equal(customerResponse.statusCode, 201);
  const customerId = decodeCreateCustomerResponse(customerResponse.json(), "$").customer.customerId;
  const caseResponse = await fixture.server.inject({
    method: "POST",
    url: `/api/v1/customers/${customerId}/cases`,
    headers: mutationHeaders(fixture),
    payload: JSON.stringify({ title: "Renderer crash" }),
  });
  assert.equal(caseResponse.statusCode, 201);
  const caseId = decodeCaseSummary(caseResponse.json(), "$").caseId;
  const transition = await fixture.server.inject({
    method: "POST",
    url: `/api/v1/cases/${caseId}/transitions`,
    headers: mutationHeaders(fixture),
    payload: JSON.stringify({ action: "StartInvestigation" }),
  });
  assert.equal(transition.statusCode, 200);
  return caseId;
}

/** One batch upload grant over HTTP; returns the grant secret. */
async function createGrantOverHttp(fixture: Fixture, caseId: string): Promise<string> {
  const response = await fixture.server.inject({
    method: "POST",
    url: `/api/v1/cases/${caseId}/grants`,
    headers: mutationHeaders(fixture),
    payload: JSON.stringify({ validForHours: 24, maxBytes: "10737418240", maxUploads: 128 }),
  });
  assert.equal(response.statusCode, 201);
  const decoded = decodeCreateGrantResponse(response.json(), "$");
  const secret = parseUploadFragment(decoded.uploadPath.replace(/^\/upload#/, "#"));
  assert.ok(secret, "grant response must carry the upload secret");
  return secret;
}

interface UploadedDump {
  readonly dumpId: string;
  readonly sha256: string;
  readonly bytes: Buffer;
}

/** One full HTTP upload that must land `available`. */
async function uploadDump(fixture: Fixture, grantSecret: string, bytes: Buffer, filename: string): Promise<UploadedDump> {
  const response = await fixture.server.inject({
    method: "POST",
    url: "/api/v1/uploads",
    headers: {
      "content-type": "application/octet-stream",
      "x-upload-grant": grantSecret,
      "x-dump-filename-base64url": encodeFilenameBase64url(filename),
    },
    payload: bytes,
  });
  assert.equal(response.statusCode, 201);
  const receipt = decodeUploadCompleteResponse(response.json(), "$");
  assert.equal(receipt.phase, "available");
  assert.equal(receipt.byteSize, BigInt(bytes.byteLength));
  assert.equal(receipt.sha256, createHash("sha256").update(bytes).digest("hex"));
  return { dumpId: receipt.dumpId, sha256: receipt.sha256, bytes };
}

/* ------------------------------------------------------------------------ */

test("catalog list serves rows and filters, with pinned bearer/session precedence", async t => {
  const fixture = await makeFixture({ analyzerTokenHash: ANALYZER_TOKEN_HASH });
  const { server, engine, cookie } = fixture;
  t.after(async () => { await server.close(); engine.close(); });

  const caseId = await createCaseOverHttp(fixture);
  const grant = await createGrantOverHttp(fixture, caseId);
  const uploaded = await uploadDump(fixture, grant, syntheticMinidump({ memoryListSizes: [8] }), "renderer.dmp");

  // Anonymous: the generic 401 envelope.
  const anon = await server.inject({ method: "GET", url: "/api/v1/dumps" });
  assert.equal(anon.statusCode, 401);
  assert.equal(errorCode(anon), "unauthenticated");

  // Wrong token + valid session cookie: the Authorization header selects the
  // bearer path only, so the cookie never rescues it, and it is a 401 (not a
  // CSRF/forbidden signal).
  const wrongWithCookie = await server.inject({
    method: "GET", url: "/api/v1/dumps",
    headers: { cookie, authorization: "Bearer wrong-token" },
  });
  assert.equal(wrongWithCookie.statusCode, 401);
  assert.equal(errorCode(wrongWithCookie), "unauthenticated");

  // Malformed Authorization header + valid cookie: same 401, never a fallback.
  const malformedWithCookie = await server.inject({
    method: "GET", url: "/api/v1/dumps",
    headers: { cookie, authorization: "Basic dXNlcjpwYXNz" },
  });
  assert.equal(malformedWithCookie.statusCode, 401);
  assert.equal(errorCode(malformedWithCookie), "unauthenticated");

  // Session-only caller (no Authorization header) is unchanged.
  const sessionList = await server.inject({ method: "GET", url: "/api/v1/dumps", headers: { cookie } });
  assert.equal(sessionList.statusCode, 200);
  const listed = decodeDumpCatalogResponse(sessionList.json(), "$");
  assert.equal(listed.dumps.length, 1);
  const entry = listed.dumps[0];
  assert.ok(entry !== undefined);
  assert.equal(entry.dumpId, uploaded.dumpId);
  assert.equal(entry.caseId, caseId);
  assert.equal(entry.phase, "available");
  assert.equal(entry.validation, "valid");
  assert.equal(entry.originalName, "renderer.dmp");
  assert.equal(entry.byteSize, BigInt(uploaded.bytes.byteLength));
  assert.equal(entry.sha256, uploaded.sha256);
  assert.ok(!("nextCursor" in listed), "a single page must not carry a cursor");

  // Filters: exact content hash, and an exact phase with no members.
  const byHash = await server.inject({ method: "GET", url: `/api/v1/dumps?sha256=${uploaded.sha256}`, headers: { cookie } });
  assert.equal(byHash.statusCode, 200);
  assert.deepEqual(decodeDumpCatalogResponse(byHash.json(), "$").dumps.map(item => item.dumpId), [uploaded.dumpId]);
  const byPhase = await server.inject({ method: "GET", url: "/api/v1/dumps?phase=rejected", headers: { cookie } });
  assert.equal(byPhase.statusCode, 200);
  assert.deepEqual(decodeDumpCatalogResponse(byPhase.json(), "$"), { dumps: [] });

  // Unknown parameters and malformed filter values are invalid_request.
  const unknown = await server.inject({ method: "GET", url: "/api/v1/dumps?limit=5", headers: { cookie } });
  assert.equal(unknown.statusCode, 400);
  assert.equal(errorCode(unknown), "invalid_request");
  const badFilter = await server.inject({ method: "GET", url: "/api/v1/dumps?sha256=not-a-hash", headers: { cookie } });
  assert.equal(badFilter.statusCode, 400);
  assert.equal(errorCode(badFilter), "invalid_request");

  // Valid analyzer token alone (no cookie, no CSRF) opens the same read.
  const tokenList = await server.inject({ method: "GET", url: "/api/v1/dumps", headers: bearer(ANALYZER_TOKEN) });
  assert.equal(tokenList.statusCode, 200);
  assert.deepEqual(decodeDumpCatalogResponse(tokenList.json(), "$").dumps.map(item => item.dumpId), [uploaded.dumpId]);
});

test("catalog pages over HTTP with the opaque keyset cursor", async t => {
  const fixture = await makeFixture({ analyzerTokenHash: ANALYZER_TOKEN_HASH });
  const { server, engine, clock, cookie } = fixture;
  t.after(async () => { await server.close(); engine.close(); });

  const caseId = await createCaseOverHttp(fixture);
  const firstGrant = await createGrantOverHttp(fixture, caseId);
  const secondGrant = await createGrantOverHttp(fixture, caseId);

  // MAX_CATALOG_PAGE + 4 rows across two received-at windows: the page
  // boundary lands inside the second window, so resumption can only be
  // correct via the (receivedAt, dumpId) keyset.
  const total = MAX_CATALOG_PAGE + 4;
  const windowA = "2026-09-16T08:00:01.000Z";
  const windowB = "2026-09-16T08:00:02.000Z";
  const seeded: string[] = [];
  for (let index = 0; index < total; index += 1) {
    clock.set(index < 100 ? windowA : windowB);
    const begun = engine.execute({
      type: "BeginUpload",
      grantSecret: index < 128 ? firstGrant : secondGrant,
      originalName: `bulk-${index}.dmp`,
    });
    assert.ok(begun.ok && begun.dumpId !== undefined);
    seeded.push(begun.dumpId);
  }

  const firstPageResponse = await server.inject({ method: "GET", url: "/api/v1/dumps", headers: bearer(ANALYZER_TOKEN) });
  assert.equal(firstPageResponse.statusCode, 200);
  const firstPage = decodeDumpCatalogResponse(firstPageResponse.json(), "$");
  assert.equal(firstPage.dumps.length, MAX_CATALOG_PAGE);
  assert.equal(firstPage.dumps[0]?.dumpId, seeded[0]);
  const cursor = firstPage.nextCursor;
  assert.ok(cursor !== undefined, "a full page must carry the next cursor");

  // Resume with the session cookie: both channels share the same guard.
  const secondPageResponse = await server.inject({
    method: "GET", url: `/api/v1/dumps?cursor=${encodeURIComponent(cursor)}`,
    headers: { cookie },
  });
  assert.equal(secondPageResponse.statusCode, 200);
  const secondPage = decodeDumpCatalogResponse(secondPageResponse.json(), "$");
  assert.equal(secondPage.dumps.length, total - MAX_CATALOG_PAGE);
  assert.ok(!("nextCursor" in secondPage), "the final page must not carry a cursor");
  assert.equal(secondPage.dumps[0]?.dumpId, seeded[MAX_CATALOG_PAGE]);

  const collected = [...firstPage.dumps.map(item => item.dumpId), ...secondPage.dumps.map(item => item.dumpId)];
  assert.equal(new Set(collected).size, total, "pages must be duplicate-free");
  assert.deepEqual(collected, seeded, "pages must be gapless and in intake order");

  // An unparsable cursor is invalid_request, never a silent restart.
  const badCursor = await server.inject({ method: "GET", url: "/api/v1/dumps?cursor=%21%21", headers: { cookie } });
  assert.equal(badCursor.statusCode, 400);
  assert.equal(errorCode(badCursor), "invalid_request");
});

test("by-sha256 serves hits and misses, and rejects malformed digests", async t => {
  const fixture = await makeFixture({ analyzerTokenHash: ANALYZER_TOKEN_HASH });
  const { server, engine, cookie } = fixture;
  t.after(async () => { await server.close(); engine.close(); });

  const caseId = await createCaseOverHttp(fixture);
  const grant = await createGrantOverHttp(fixture, caseId);
  const first = await uploadDump(fixture, grant, syntheticMinidump({ memoryListSizes: [8] }), "first.dmp");
  const other = await uploadDump(fixture, grant, syntheticMinidump({ memoryListSizes: [16] }), "other.dmp");
  assert.notEqual(first.sha256, other.sha256);

  // Hit with the analyzer token alone, no cookie.
  const hit = await server.inject({
    method: "GET", url: `/api/v1/dumps/by-sha256/${first.sha256}`,
    headers: bearer(ANALYZER_TOKEN),
  });
  assert.equal(hit.statusCode, 200);
  const hitBody = decodeDumpCatalogResponse(hit.json(), "$");
  assert.deepEqual(hitBody.dumps.map(item => item.dumpId), [first.dumpId]);
  assert.equal(hitBody.dumps[0]?.sha256, first.sha256);
  assert.ok(!("nextCursor" in hitBody));

  // A miss is an empty page, not a 404.
  const miss = await server.inject({
    method: "GET", url: `/api/v1/dumps/by-sha256/${"0".repeat(64)}`,
    headers: { cookie },
  });
  assert.equal(miss.statusCode, 200);
  assert.deepEqual(decodeDumpCatalogResponse(miss.json(), "$"), { dumps: [] });

  // Bad shape (length, case, non-hex) is invalid_request; auth still runs first.
  for (const bad of ["1".repeat(63), "A".repeat(64), `${"1".repeat(63)}g`]) {
    const response = await server.inject({ method: "GET", url: `/api/v1/dumps/by-sha256/${bad}`, headers: { cookie } });
    assert.equal(response.statusCode, 400, `sha256 ${bad} must be rejected`);
    assert.equal(errorCode(response), "invalid_request");
  }
  const anon = await server.inject({ method: "GET", url: `/api/v1/dumps/by-sha256/${first.sha256}` });
  assert.equal(anon.statusCode, 401);
});

test("the analyzer token is rejected on representative mutations", async t => {
  const fixture = await makeFixture({ analyzerTokenHash: ANALYZER_TOKEN_HASH });
  const { server, engine, cookie } = fixture;
  t.after(async () => { await server.close(); engine.close(); });

  const caseId = await createCaseOverHttp(fixture);
  const grant = await createGrantOverHttp(fixture, caseId);
  const uploaded = await uploadDump(fixture, grant, syntheticMinidump({ memoryListSizes: [8] }), "renderer.dmp");
  const beforeCustomers = engine.snapshot().customers.length;

  const createCustomer = await server.inject({
    method: "POST", url: "/api/v1/customers",
    headers: { ...bearer(ANALYZER_TOKEN), "content-type": "application/json" },
    payload: JSON.stringify({ displayName: "Token Is Not An Operator" }),
  });
  assert.equal(createCustomer.statusCode, 401);
  assert.equal(errorCode(createCustomer), "unauthenticated");

  const retention = await server.inject({
    method: "PUT", url: `/api/v1/dumps/${uploaded.dumpId}/retention`,
    headers: { ...bearer(ANALYZER_TOKEN), "content-type": "application/json" },
    payload: JSON.stringify({ days: 2 }),
  });
  assert.equal(retention.statusCode, 401);
  assert.equal(errorCode(retention), "unauthenticated");

  const symbol = await server.inject({
    method: "POST", url: "/api/v1/symbols",
    headers: {
      ...bearer(ANALYZER_TOKEN),
      "content-type": "application/octet-stream",
      [X_SYMBOL_FILENAME_HEADER]: encodeSymbolFilenameBase64url("electron.pdb"),
    },
    payload: Buffer.from("not a pdb"),
  });
  assert.equal(symbol.statusCode, 401);
  assert.equal(errorCode(symbol), "unauthenticated");

  // Nothing was created or changed by the rejected mutations.
  assert.equal(engine.snapshot().customers.length, beforeCustomers);
  assert.equal(engine.snapshot().dumps.find(dump => dump.dumpId === uploaded.dumpId)?.purgeAt, null);
  const sessionSymbols = await server.inject({ method: "GET", url: "/api/v1/symbols", headers: { cookie } });
  assert.equal(sessionSymbols.statusCode, 200);
  assert.deepEqual(decodeSymbolListResponse(sessionSymbols.json(), "$"), { symbols: [] });
});

test("bearer requests are rejected while the analyzer token is disabled", async t => {
  const fixture = await makeFixture();
  const { server, engine, cookie } = fixture;
  t.after(async () => { await server.close(); engine.close(); });

  const list = await server.inject({ method: "GET", url: "/api/v1/dumps", headers: bearer(ANALYZER_TOKEN) });
  assert.equal(list.statusCode, 401);
  assert.equal(errorCode(list), "unauthenticated");
  const bySha = await server.inject({
    method: "GET", url: `/api/v1/dumps/by-sha256/${"0".repeat(64)}`,
    headers: bearer(ANALYZER_TOKEN),
  });
  assert.equal(bySha.statusCode, 401);

  // The header still suppresses the cookie path while disabled.
  const withCookie = await server.inject({
    method: "GET", url: "/api/v1/dumps",
    headers: { cookie, authorization: `Bearer ${ANALYZER_TOKEN}` },
  });
  assert.equal(withCookie.statusCode, 401);

  // The session path is unchanged.
  const session = await server.inject({ method: "GET", url: "/api/v1/dumps", headers: { cookie } });
  assert.equal(session.statusCode, 200);
});

test("content serves a strong ETag and honors exact/list If-None-Match with 304", async t => {
  const fixture = await makeFixture({ analyzerTokenHash: ANALYZER_TOKEN_HASH });
  const { server, engine, cookie } = fixture;
  t.after(async () => { await server.close(); engine.close(); });

  const caseId = await createCaseOverHttp(fixture);
  const grant = await createGrantOverHttp(fixture, caseId);
  const bytes = syntheticMinidump({ memoryListSizes: [8] });
  const uploaded = await uploadDump(fixture, grant, bytes, "renderer.dmp");
  const etag = `"${uploaded.sha256}"`;

  const first = await server.inject({ method: "GET", url: `/api/v1/dumps/${uploaded.dumpId}/content`, headers: { cookie } });
  assert.equal(first.statusCode, 200);
  assert.deepEqual(first.rawPayload, bytes);
  assert.equal(first.headers.etag, etag);
  assert.equal(first.headers["cache-control"], "no-store");

  // Exact match short-circuits to an empty 304 that still carries the validator.
  const revalidated = await server.inject({
    method: "GET", url: `/api/v1/dumps/${uploaded.dumpId}/content`,
    headers: { cookie, "if-none-match": etag },
  });
  assert.equal(revalidated.statusCode, 304);
  assert.equal(revalidated.rawPayload.byteLength, 0);
  assert.equal(revalidated.headers.etag, etag);
  assert.equal(revalidated.headers["cache-control"], "no-store");

  // A list containing the validator matches too; a list without it downloads.
  const listed = await server.inject({
    method: "GET", url: `/api/v1/dumps/${uploaded.dumpId}/content`,
    headers: { cookie, "if-none-match": `"ffffffff", ${etag}` },
  });
  assert.equal(listed.statusCode, 304);
  const stale = await server.inject({
    method: "GET", url: `/api/v1/dumps/${uploaded.dumpId}/content`,
    headers: { cookie, "if-none-match": `"${"0".repeat(64)}"` },
  });
  assert.equal(stale.statusCode, 200);
  assert.deepEqual(stale.rawPayload, bytes);

  // The validator belongs to the bytes: a different dump carries its own.
  const otherGrant = await createGrantOverHttp(fixture, caseId);
  const other = await uploadDump(fixture, otherGrant, syntheticMinidump({ memoryListSizes: [16] }), "other.dmp");
  const otherContent = await server.inject({ method: "GET", url: `/api/v1/dumps/${other.dumpId}/content`, headers: { cookie } });
  assert.equal(otherContent.statusCode, 200);
  assert.equal(otherContent.headers.etag, `"${other.sha256}"`);
  assert.notEqual(otherContent.headers.etag, etag);
});

test("the analyzer token reaches dump detail and content with ETag revalidation", async t => {
  const fixture = await makeFixture({ analyzerTokenHash: ANALYZER_TOKEN_HASH });
  const { server, engine, cookie } = fixture;
  t.after(async () => { await server.close(); engine.close(); });

  const caseId = await createCaseOverHttp(fixture);
  const grant = await createGrantOverHttp(fixture, caseId);
  const bytes = syntheticMinidump({ memoryListSizes: [8] });
  const uploaded = await uploadDump(fixture, grant, bytes, "renderer.dmp");
  const etag = `"${uploaded.sha256}"`;

  // Wrong token + valid session cookie: the Authorization header selects the
  // bearer path only, so both reads are 401 even though the cookie is valid.
  for (const url of [`/api/v1/dumps/${uploaded.dumpId}`, `/api/v1/dumps/${uploaded.dumpId}/content`]) {
    const response = await server.inject({
      method: "GET", url,
      headers: { cookie, authorization: "Bearer wrong-token" },
    });
    assert.equal(response.statusCode, 401, url);
    assert.equal(errorCode(response), "unauthenticated", url);
  }

  // Valid token alone: dump detail decodes without any cookie.
  const detailResponse = await server.inject({
    method: "GET", url: `/api/v1/dumps/${uploaded.dumpId}`,
    headers: bearer(ANALYZER_TOKEN),
  });
  assert.equal(detailResponse.statusCode, 200);
  const detail = decodeDumpDetailResponse(detailResponse.json(), "$");
  assert.equal(detail.dumpId, uploaded.dumpId);
  assert.equal(detail.case.caseId, caseId);
  assert.equal(detail.phase, "available");
  assert.equal(detail.sha256, uploaded.sha256);
  assert.equal(detail.byteSize, BigInt(bytes.byteLength));

  // Valid token alone: content streams, then revalidates to 304 over bearer auth.
  const content = await server.inject({
    method: "GET", url: `/api/v1/dumps/${uploaded.dumpId}/content`,
    headers: bearer(ANALYZER_TOKEN),
  });
  assert.equal(content.statusCode, 200);
  assert.deepEqual(content.rawPayload, bytes);
  assert.equal(content.headers.etag, etag);
  assert.equal(content.headers["cache-control"], "no-store");

  const revalidated = await server.inject({
    method: "GET", url: `/api/v1/dumps/${uploaded.dumpId}/content`,
    headers: { ...bearer(ANALYZER_TOKEN), "if-none-match": etag },
  });
  assert.equal(revalidated.statusCode, 304);
  assert.equal(revalidated.rawPayload.byteLength, 0);
  assert.equal(revalidated.headers.etag, etag);

  // The token remains read-scoped: the retention PUT still rejects it.
  const retention = await server.inject({
    method: "PUT", url: `/api/v1/dumps/${uploaded.dumpId}/retention`,
    headers: { ...bearer(ANALYZER_TOKEN), "content-type": "application/json" },
    payload: JSON.stringify({ days: 2 }),
  });
  assert.equal(retention.statusCode, 401);
  assert.equal(errorCode(retention), "unauthenticated");
});
