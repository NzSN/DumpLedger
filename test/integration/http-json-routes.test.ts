import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type Decoder,
  decodeCaseDetailResponse,
  decodeCaseSearchResponse,
  decodeCaseSummary,
  decodeCreateCustomerResponse,
  decodeCreateGrantResponse,
  decodeDashboardResponse,
  decodeDumpDetailResponse,
  decodeErrorResponse,
  decodeOperationsResponse,
  decodeRetentionResponse,
  decodeRevokeGrantResponse,
  decodeSessionResponse,
  decodeTransitionResponse,
  decodeUploadCompleteResponse,
  encodeFilenameBase64url,
  MAX_CASE_LIST_ITEMS,
  MAX_DASHBOARD_CUSTOMERS,
  MAX_DASHBOARD_RECENT_CASES,
  parseUploadFragment,
} from "@dump-ledger/http-contracts";
import { OperatorSessions, hashOperatorPassword } from "../../src/auth/sessions.js";
import { parseDumpId, type CustomerId } from "../../src/domain/ids.js";
import { createDumpLedgerEngine, DeterministicClock, DeterministicEntropy, DeterministicIds } from "../../src/engine/dump-ledger-engine.js";
import { EngineHttpApplication } from "../../src/http/application.js";
import { buildHttpServer, type HttpServerOptions } from "../../src/http/server.js";
import { createVaultMinidumpInspectionPort } from "../../src/inspection/index.js";
import { EngineUploadLifecycle, EngineUploadPostProcessor, VaultUploadSink } from "../../src/intake/intake-facade.js";
import { UploadAdmission } from "../../src/intake/upload-admission.js";
import { MemoryVault } from "../../src/vault/memory-vault.js";
import { syntheticMinidump } from "../fixtures/minidump/synthetic-minidump.js";

const FIXED_NOW_MS = Date.parse("2026-09-04T12:00:00.000Z");

interface JsonFixture {
  readonly server: ReturnType<typeof buildHttpServer>;
  readonly engine: ReturnType<typeof createDumpLedgerEngine>;
  readonly vault: MemoryVault;
  readonly secretOf: (uploadPath: string) => string;
}

function deterministicSecrets(count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => `${"s".repeat(40)}${index.toString(36).padStart(4, "0")}`);
}

/** Builds a fresh real engine/vault fixture per test so no state leaks between cases. */
async function makeFixture(
  overrides: Partial<HttpServerOptions> = {},
  entropyCount = 16,
  serverNowMs: number = FIXED_NOW_MS,
): Promise<JsonFixture> {
  const vault = new MemoryVault();
  const engine = createDumpLedgerEngine({
    databasePath: ":memory:",
    vault,
    inspection: createVaultMinidumpInspectionPort(vault),
    grantSecretKey: Buffer.alloc(32, 0x5a),
    clock: new DeterministicClock("2026-09-04T12:00:00.000Z"),
    entropy: new DeterministicEntropy(deterministicSecrets(entropyCount)),
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
    now: () => serverNowMs,
    ...overrides,
  });
  return {
    server,
    engine,
    vault,
    secretOf: uploadPath => {
      const secret = parseUploadFragment(uploadPath.replace(/^\/upload#/, "#"));
      assert.ok(secret, `uploadPath did not carry a grant secret: ${uploadPath}`);
      return secret;
    },
  };
}

/** Bootstraps a JSON session and returns the cookie plus in-memory CSRF token. */
async function loginJson(server: ReturnType<typeof buildHttpServer>): Promise<{ cookie: string; csrf: string }> {
  const response = await server.inject({
    method: "POST",
    url: "/api/v1/session",
    headers: { "content-type": "application/json" },
    payload: JSON.stringify({ password: "local-password" }),
  });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  decodeSessionResponse(body, "$");
  assert.equal(body.authenticated, true);
  const setCookie = response.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";", 1)[0];
  assert.ok(cookie, "login response must set a session cookie");
  assert.equal(typeof body.csrfToken, "string");
  return { cookie, csrf: body.csrfToken as string };
}

function jsonHeaders(cookie: string, csrf: string): Record<string, string> {
  return { cookie, "content-type": "application/json", "x-csrf-token": csrf };
}

function postJson(server: ReturnType<typeof buildHttpServer>, url: string, cookie: string, csrf: string, body: unknown) {
  return server.inject({ method: "POST", url, headers: jsonHeaders(cookie, csrf), payload: JSON.stringify(body) });
}

function decodeError(response: { json(): unknown }): { code: string; retryable: boolean } {
  const error = decodeErrorResponse(response.json(), "$").error;
  return { code: error.code, retryable: error.retryable };
}

test("JSON session bootstrap, refresh, and logout obey CSRF and 401/403 semantics", async t => {
  const { server, engine } = await makeFixture();
  t.after(async () => { await server.close(); engine.close(); });

  // Unauthenticated bootstrap says so.
  const before = await server.inject({ method: "GET", url: "/api/v1/session" });
  assert.equal(before.statusCode, 200);
  assert.deepEqual(decodeSessionResponse(before.json(), "$"), { authenticated: false });

  // Wrong password is a stable 401 envelope, never a session.
  const wrong = await server.inject({
    method: "POST", url: "/api/v1/session", headers: { "content-type": "application/json" },
    payload: JSON.stringify({ password: "wrong-password" }),
  });
  assert.equal(wrong.statusCode, 401);
  assert.deepEqual(decodeError(wrong), { code: "unauthenticated", retryable: false });

  // Malformed login bodies are 400 invalid_request before any password check.
  const malformed = await server.inject({
    method: "POST", url: "/api/v1/session", headers: { "content-type": "application/json" },
    payload: "{not json",
  });
  assert.equal(malformed.statusCode, 400);
  assert.deepEqual(decodeError(malformed), { code: "invalid_request", retryable: false });

  const auth = await loginJson(server);

  // A reload refreshes the same session and its CSRF token from GET.
  const refresh = await server.inject({ method: "GET", url: "/api/v1/session", headers: { cookie: auth.cookie } });
  assert.equal(refresh.statusCode, 200);
  const refreshed = decodeSessionResponse(refresh.json(), "$");
  assert.equal(refreshed.authenticated, true);
  assert.equal(refreshed.csrfToken, auth.csrf);
  assert.equal(typeof refreshed.expiresAt, "string");

  // DELETE without CSRF is a visible 403 and never logs the browser out.
  const missingCsrf = await server.inject({ method: "DELETE", url: "/api/v1/session", headers: { cookie: auth.cookie } });
  assert.equal(missingCsrf.statusCode, 403);
  assert.deepEqual(decodeError(missingCsrf), { code: "forbidden", retryable: false });
  const stillIn = await server.inject({ method: "GET", url: "/api/v1/session", headers: { cookie: auth.cookie } });
  assert.equal(decodeSessionResponse(stillIn.json(), "$").authenticated, true);

  // DELETE with CSRF clears the session (204, no body).
  const logout = await server.inject({
    method: "DELETE", url: "/api/v1/session", headers: { cookie: auth.cookie, "x-csrf-token": auth.csrf },
  });
  assert.equal(logout.statusCode, 204);
  const after = await server.inject({ method: "GET", url: "/api/v1/session", headers: { cookie: auth.cookie } });
  assert.deepEqual(decodeSessionResponse(after.json(), "$"), { authenticated: false });

  // An unauthenticated DELETE is a 401, not a 403.
  const unauthLogout = await server.inject({ method: "DELETE", url: "/api/v1/session" });
  assert.equal(unauthLogout.statusCode, 401);
  assert.deepEqual(decodeError(unauthLogout), { code: "unauthenticated", retryable: false });
});

test("dashboard, customer and case creation over JSON are bounded and projection-free", async t => {
  const { server, engine } = await makeFixture();
  t.after(async () => { await server.close(); engine.close(); });
  const auth = await loginJson(server);

  // Unauthenticated reads and mutations carry the stable 401 envelope.
  assert.equal((await server.inject({ method: "GET", url: "/api/v1/dashboard" })).statusCode, 401);
  assert.equal((await server.inject({ method: "POST", url: "/api/v1/customers", payload: JSON.stringify({ displayName: "Acme" }) })).statusCode, 401);

  // Authenticated but missing CSRF is 403 and creates nothing.
  const noCsrf = await server.inject({
    method: "POST", url: "/api/v1/customers",
    headers: { cookie: auth.cookie, "content-type": "application/json" },
    payload: JSON.stringify({ displayName: "Acme" }),
  });
  assert.equal(noCsrf.statusCode, 403);
  assert.deepEqual(decodeError(noCsrf), { code: "forbidden", retryable: false });
  assert.equal(engine.snapshot().customers.length, 0);

  // Malformed create-customer body is 400.
  const malformed = await postJson(server, "/api/v1/customers", auth.cookie, auth.csrf, { displayName: "" });
  assert.equal(malformed.statusCode, 400);
  assert.deepEqual(decodeError(malformed), { code: "invalid_request", retryable: false });

  // Positive create customer returns the server state.
  const createdCustomer = await postJson(server, "/api/v1/customers", auth.cookie, auth.csrf, { displayName: "Acme <Support>" });
  assert.equal(createdCustomer.statusCode, 201);
  const customer = decodeCreateCustomerResponse(createdCustomer.json(), "$").customer;
  assert.equal(customer.displayName, "Acme <Support>");
  const customerId = customer.customerId;

  // Positive create case returns a `new` case summary.
  const createdCase = await postJson(server, `/api/v1/customers/${customerId}/cases`, auth.cookie, auth.csrf, { title: "Renderer crash on startup" });
  assert.equal(createdCase.statusCode, 201);
  const caseSummary = decodeCaseSummary(createdCase.json(), "$");
  assert.equal(caseSummary.status, "new");
  const caseId = caseSummary.caseId;

  // Dashboard response decodes and is projection-free.
  const dashboard = await server.inject({ method: "GET", url: "/api/v1/dashboard", headers: { cookie: auth.cookie } });
  assert.equal(dashboard.statusCode, 200);
  const decodedDashboard = decodeDashboardResponse(dashboard.json(), "$");
  assert.deepEqual(decodedDashboard.counts, { customers: 1, activeCases: 1, availableDumps: 0, processingDumps: 0 });
  assert.equal(decodedDashboard.customers.length, 1);
  assert.equal(decodedDashboard.recentCases.length, 1);
  assert.equal(decodedDashboard.recentCases[0]?.caseId, caseId);
  for (const forbidden of ["auditEvents", "blobState", "secretDigest", "grantSecret"]) {
    assert.ok(!dashboard.body.includes(forbidden), `dashboard leaked ${forbidden}`);
  }

  // Search decodes, matches by title, and stays bounded.
  const search = await server.inject({ method: "GET", url: "/api/v1/cases?query=renderer", headers: { cookie: auth.cookie } });
  assert.equal(search.statusCode, 200);
  const decodedSearch = decodeCaseSearchResponse(search.json(), "$");
  assert.equal(decodedSearch.cases.length, 1);
  assert.equal(decodedSearch.cases[0]?.caseId, caseId);
  assert.equal(decodedSearch.nextCursor, undefined);
  assert.ok(!search.body.includes("auditEvents"));
});

test("case workflow transitions are engine-authoritative over JSON with illegal-transition coverage", async t => {
  const { server, engine } = await makeFixture();
  t.after(async () => { await server.close(); engine.close(); });
  const auth = await loginJson(server);

  const customer = decodeCreateCustomerResponse(
    (await postJson(server, "/api/v1/customers", auth.cookie, auth.csrf, { displayName: "Acme" })).json(), "$",
  ).customer;
  const created = await postJson(server, `/api/v1/customers/${customer.customerId}/cases`, auth.cookie, auth.csrf, { title: "Investigate 42" });
  const caseId = decodeCaseSummary(created.json(), "$").caseId;

  const transition = (action: string) =>
    postJson(server, `/api/v1/cases/${caseId}/transitions`, auth.cookie, auth.csrf, { action });

  // A `new` case may only StartInvestigation; every other action is a stable 409.
  const detailNew = await server.inject({ method: "GET", url: `/api/v1/cases/${caseId}`, headers: { cookie: auth.cookie } });
  assert.equal(detailNew.statusCode, 200);
  const decodedNew = decodeCaseDetailResponse(detailNew.json(), "$");
  assert.deepEqual(decodedNew.allowedActions, ["StartInvestigation"]);
  assert.equal(decodedNew.grants.length, 0);
  assert.equal(decodedNew.dumps.length, 0);

  const illegalNew = await transition("CloseCase");
  assert.equal(illegalNew.statusCode, 409);
  assert.deepEqual(decodeError(illegalNew), { code: "invalid_transition", retryable: false });
  assert.equal(engine.snapshot().cases[0]?.status, "new");

  // Missing CSRF on a legal transition is 403 and changes nothing.
  const noCsrf = await server.inject({
    method: "POST", url: `/api/v1/cases/${caseId}/transitions`,
    headers: { cookie: auth.cookie, "content-type": "application/json" },
    payload: JSON.stringify({ action: "StartInvestigation" }),
  });
  assert.equal(noCsrf.statusCode, 403);
  assert.equal(engine.snapshot().cases[0]?.status, "new");

  // The full legal path: StartInvestigation -> WaitForCustomer -> ResumeInvestigation -> ResolveCase.
  const expected = [
    ["StartInvestigation", "investigating"],
    ["WaitForCustomer", "waiting-for-customer"],
    ["ResumeInvestigation", "investigating"],
    ["ResolveCase", "resolved"],
  ] as const;
  for (const [action, status] of expected) {
    const response = await transition(action);
    assert.equal(response.statusCode, 200, `${action} should succeed`);
    const decoded = decodeTransitionResponse(response.json(), "$");
    assert.equal(decoded.action, action);
    assert.equal(decoded.status, status);
    assert.equal(decoded.revokedGrants, undefined, `${action} must not carry a revocation summary`);
  }

  // Resolved allows CloseCase (returned in detail) but the guidance is not enough:
  // WaitForCustomer from resolved is rejected by the engine.
  const resolvedDetail = await server.inject({ method: "GET", url: `/api/v1/cases/${caseId}`, headers: { cookie: auth.cookie } });
  assert.deepEqual(decodeCaseDetailResponse(resolvedDetail.json(), "$").allowedActions, ["ResumeInvestigation", "CloseCase"]);
  const illegalResolved = await transition("WaitForCustomer");
  assert.equal(illegalResolved.statusCode, 409);
  assert.deepEqual(decodeError(illegalResolved), { code: "invalid_transition", retryable: false });

  // CloseCase with no issued grants returns an explicit empty revocation summary.
  const closed = await transition("CloseCase");
  assert.equal(closed.statusCode, 200);
  const decodedClosed = decodeTransitionResponse(closed.json(), "$");
  assert.equal(decodedClosed.status, "closed");
  assert.deepEqual(decodedClosed.revokedGrants, { count: 0, grantIds: [] });

  const closedDetail = await server.inject({ method: "GET", url: `/api/v1/cases/${caseId}`, headers: { cookie: auth.cookie } });
  assert.deepEqual(decodeCaseDetailResponse(closedDetail.json(), "$").allowedActions, ["ResumeInvestigation"]);

  // Unknown resource: well-formed but absent case id is a 404 envelope.
  const missing = await server.inject({ method: "GET", url: "/api/v1/cases/case_0000000000000000000000000Z", headers: { cookie: auth.cookie } });
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(decodeError(missing), { code: "not_found", retryable: false });
});

test("grant creation, header-grant upload, filename fallback, dump content, server-clock retention, and CloseCase revocation", async t => {
  const { server, engine, vault, secretOf } = await makeFixture();
  t.after(async () => { await server.close(); engine.close(); });
  const auth = await loginJson(server);

  const customer = decodeCreateCustomerResponse(
    (await postJson(server, "/api/v1/customers", auth.cookie, auth.csrf, { displayName: "Acme" })).json(), "$",
  ).customer;
  const createdCase = await postJson(server, `/api/v1/customers/${customer.customerId}/cases`, auth.cookie, auth.csrf, { title: "Crash collection" });
  const caseId = decodeCaseSummary(createdCase.json(), "$").caseId;
  await postJson(server, `/api/v1/cases/${caseId}/transitions`, auth.cookie, auth.csrf, { action: "StartInvestigation" });

  const createGrant = async () => {
    const response = await postJson(server, `/api/v1/cases/${caseId}/grants`, auth.cookie, auth.csrf, {
      validForHours: 24,
      maxBytes: "10737418240",
    });
    assert.equal(response.statusCode, 201);
    const decoded = decodeCreateGrantResponse(response.json(), "$");
    assert.match(decoded.uploadPath, /^\/upload#grant=[A-Za-z0-9_-]+$/);
    assert.equal(decoded.grant.state, "issued");
    assert.equal(decoded.grant.maxBytes, 10737418240n);
    return { grant: decoded.grant, secret: secretOf(decoded.uploadPath) };
  };

  // Grant A is consumed by a header-grant upload with a real Unicode-safe filename.
  const grantA = await createGrant();
  const validDump = syntheticMinidump({ memoryListSizes: [8] });
  const uploadA = await server.inject({
    method: "POST", url: "/api/v1/uploads",
    headers: {
      "content-type": "application/octet-stream",
      "x-upload-grant": grantA.secret,
      "x-dump-filename-base64url": encodeFilenameBase64url("renderer.dmp"),
    },
    payload: validDump,
  });
  assert.equal(uploadA.statusCode, 201);
  const receiptA = decodeUploadCompleteResponse(uploadA.json(), "$");
  assert.equal(receiptA.phase, "available");
  assert.equal(receiptA.byteSize, 72n);
  const dumpIdA = receiptA.dumpId;

  // Grant B upload without a filename header falls back to upload.dmp (201, not an error).
  const grantB = await createGrant();
  const uploadB = await server.inject({
    method: "POST", url: "/api/v1/uploads",
    headers: { "content-type": "application/octet-stream", "x-upload-grant": grantB.secret },
    payload: syntheticMinidump({ memoryListSizes: [8] }),
  });
  assert.equal(uploadB.statusCode, 201);
  const dumpIdB = decodeUploadCompleteResponse(uploadB.json(), "$").dumpId;

  // Grant C upload with an invalid base64url filename header also falls back.
  const grantC = await createGrant();
  const uploadC = await server.inject({
    method: "POST", url: "/api/v1/uploads",
    headers: {
      "content-type": "application/octet-stream",
      "x-upload-grant": grantC.secret,
      "x-dump-filename-base64url": "not-base64url!!!",
    },
    payload: syntheticMinidump({ memoryListSizes: [8] }),
  });
  assert.equal(uploadC.statusCode, 201);
  const dumpIdC = decodeUploadCompleteResponse(uploadC.json(), "$").dumpId;

  // Replay of a consumed grant fails closed with 404 grant_unavailable.
  const replay = await server.inject({
    method: "POST", url: "/api/v1/uploads",
    headers: { "content-type": "application/octet-stream", "x-upload-grant": grantA.secret },
    payload: Buffer.from("MDMP"),
  });
  assert.equal(replay.statusCode, 404);
  assert.deepEqual(decodeError(replay), { code: "grant_unavailable", retryable: false });

  // Dump detail reports the decoded filename, lifecycle, coverage and activity.
  const detailA = await server.inject({ method: "GET", url: `/api/v1/dumps/${dumpIdA}`, headers: { cookie: auth.cookie } });
  assert.equal(detailA.statusCode, 200);
  const decodedDump = decodeDumpDetailResponse(detailA.json(), "$");
  assert.equal(decodedDump.dumpId, dumpIdA);
  assert.equal(decodedDump.case.caseId, caseId);
  assert.equal(decodedDump.phase, "available");
  assert.equal(decodedDump.originalName, "renderer.dmp");
  assert.equal(decodedDump.byteSize, 72n);
  assert.equal(decodedDump.downloadable, true);
  assert.ok(decodedDump.activity.some(event => event.action === "AcceptDump"));
  const detailB = await server.inject({ method: "GET", url: `/api/v1/dumps/${dumpIdB}`, headers: { cookie: auth.cookie } });
  assert.equal(decodeDumpDetailResponse(detailB.json(), "$").originalName, "upload.dmp");
  const detailC = await server.inject({ method: "GET", url: `/api/v1/dumps/${dumpIdC}`, headers: { cookie: auth.cookie } });
  assert.equal(decodeDumpDetailResponse(detailC.json(), "$").originalName, "upload.dmp");

  // Raw content is an authenticated streaming download with Content-Disposition.
  const unauthenticatedContent = await server.inject({ method: "GET", url: `/api/v1/dumps/${dumpIdA}/content` });
  assert.equal(unauthenticatedContent.statusCode, 401);
  const contentA = await server.inject({ method: "GET", url: `/api/v1/dumps/${dumpIdA}/content`, headers: { cookie: auth.cookie } });
  assert.equal(contentA.statusCode, 200);
  assert.deepEqual(contentA.rawPayload, validDump);
  assert.ok(contentA.headers["content-disposition"]?.startsWith("attachment; filename="));

  // Retention deadline derives from the server clock: now + days, canonical UTC.
  const retention = await server.inject({
    method: "PUT", url: `/api/v1/dumps/${dumpIdA}/retention`,
    headers: jsonHeaders(auth.cookie, auth.csrf),
    payload: JSON.stringify({ days: 2 }),
  });
  assert.equal(retention.statusCode, 200);
  const decodedRetention = decodeRetentionResponse(retention.json(), "$");
  assert.equal(decodedRetention.dump.dumpId, dumpIdA);
  assert.equal(decodedRetention.dump.purgeAt, "2026-09-06T12:00:00.000Z");
  const afterRetention = await server.inject({ method: "GET", url: `/api/v1/dumps/${dumpIdA}`, headers: { cookie: auth.cookie } });
  assert.equal(decodeDumpDetailResponse(afterRetention.json(), "$").purgeAt, "2026-09-06T12:00:00.000Z");
  assert.equal(vault.inspectPresence(parseDumpId(dumpIdA)).vault, true);

  // An issued grant D is atomically revoked by CloseCase with identifiers returned.
  const grantD = await createGrant();
  const close = await postJson(server, `/api/v1/cases/${caseId}/transitions`, auth.cookie, auth.csrf, { action: "ResolveCase" });
  assert.equal(close.statusCode, 200);
  // Transition already done above; use the current flow: case was investigating, resolve then close.
  const closed = await postJson(server, `/api/v1/cases/${caseId}/transitions`, auth.cookie, auth.csrf, { action: "CloseCase" });
  assert.equal(closed.statusCode, 200);
  const decodedClose = decodeTransitionResponse(closed.json(), "$");
  assert.equal(decodedClose.status, "closed");
  assert.deepEqual(decodedClose.revokedGrants, { count: 1, grantIds: [grantD.grant.grantId] });

  // CloseCase revokes but never changes dump retention or downloadability.
  const engineGrant = engine.snapshot().grants.find(grant => grant.grantId === grantD.grant.grantId);
  assert.equal(engineGrant?.state, "revoked");
  const stillContent = await server.inject({ method: "GET", url: `/api/v1/dumps/${dumpIdA}/content`, headers: { cookie: auth.cookie } });
  assert.equal(stillContent.statusCode, 200);
  assert.deepEqual(stillContent.rawPayload, validDump);
  const stillPurge = await server.inject({ method: "GET", url: `/api/v1/dumps/${dumpIdA}`, headers: { cookie: auth.cookie } });
  assert.equal(decodeDumpDetailResponse(stillPurge.json(), "$").purgeAt, "2026-09-06T12:00:00.000Z");

  // Case detail after CloseCase shows the revoked grant and the bounded dump rows.
  const closedCaseDetail = await server.inject({ method: "GET", url: `/api/v1/cases/${caseId}`, headers: { cookie: auth.cookie } });
  const detail = decodeCaseDetailResponse(closedCaseDetail.json(), "$");
  assert.equal(detail.status, "closed");
  assert.equal(detail.grants.length, 4);
  assert.ok(detail.grants.every(grant => grant.state !== "issued"));
  assert.equal(detail.dumps.length, 3);

  // Revoking an already-revoked grant returns the stable invalid_transition error.
  const revokeAgain = await postJson(server, `/api/v1/grants/${grantD.grant.grantId}/revoke`, auth.cookie, auth.csrf, {});
  assert.equal(revokeAgain.statusCode, 409);
  assert.deepEqual(decodeError(revokeAgain), { code: "invalid_transition", retryable: false });
});

test("grant revoke endpoint, manifest, operations, and malformed/unauthorized variants", async t => {
  const { server, engine } = await makeFixture();
  t.after(async () => { await server.close(); engine.close(); });
  const auth = await loginJson(server);

  const customer = decodeCreateCustomerResponse(
    (await postJson(server, "/api/v1/customers", auth.cookie, auth.csrf, { displayName: "Acme" })).json(), "$",
  ).customer;
  const caseId = decodeCaseSummary(
    (await postJson(server, `/api/v1/customers/${customer.customerId}/cases`, auth.cookie, auth.csrf, { title: "Manifest case" })).json(), "$",
  ).caseId;

  // Manifest is a downloadable export carrying a schema version.
  const manifest = await server.inject({ method: "GET", url: `/api/v1/cases/${caseId}/manifest`, headers: { cookie: auth.cookie } });
  assert.equal(manifest.statusCode, 200);
  assert.equal(manifest.json().schema, "dump-ledger.case-manifest/v1");
  assert.equal(manifest.json().case.status, "new");
  assert.equal(manifest.json().dumps.length, 0);
  const missingManifest = await server.inject({ method: "GET", url: "/api/v1/cases/case_0000000000000000000000000Z/manifest", headers: { cookie: auth.cookie } });
  assert.equal(missingManifest.statusCode, 404);
  assert.deepEqual(decodeError(missingManifest), { code: "not_found", retryable: false });

  // Grant revocation returns the resulting revoked state.
  const grantResponse = await postJson(server, `/api/v1/cases/${caseId}/grants`, auth.cookie, auth.csrf, { validForHours: 24, maxBytes: "2048" });
  const grant = decodeCreateGrantResponse(grantResponse.json(), "$").grant;
  const revoke = await postJson(server, `/api/v1/grants/${grant.grantId}/revoke`, auth.cookie, auth.csrf, {});
  assert.equal(revoke.statusCode, 200);
  const revoked = decodeRevokeGrantResponse(revoke.json(), "$").grant;
  assert.equal(revoked.grantId, grant.grantId);
  assert.equal(revoked.state, "revoked");
  assert.equal(engine.snapshot().grants.find(item => item.grantId === grant.grantId)?.state, "revoked");

  // Grant creation on a malformed body is 400 and leaves no grant behind.
  const before = engine.snapshot().grants.length;
  const malformedGrant = await postJson(server, `/api/v1/cases/${caseId}/grants`, auth.cookie, auth.csrf, { validForHours: "24", maxBytes: "2048" });
  assert.equal(malformedGrant.statusCode, 400);
  assert.deepEqual(decodeError(malformedGrant), { code: "invalid_request", retryable: false });
  assert.equal(engine.snapshot().grants.length, before);

  // Operations summary decodes to a bounded, projection-free shape.
  const operations = await server.inject({ method: "GET", url: "/api/v1/operations", headers: { cookie: auth.cookie } });
  assert.equal(operations.statusCode, 200);
  const decodedOps = decodeOperationsResponse(operations.json(), "$");
  assert.equal(decodedOps.integrity.status, "ok");
  assert.equal(decodedOps.integrity.errorCount, 0);
  assert.ok(!operations.body.includes("dump_ledger_session"));
  assert.ok(!operations.body.includes("grant"));

  // Operations is authenticated; unauthenticated reads are 401.
  assert.equal((await server.inject({ method: "GET", url: "/api/v1/operations" })).statusCode, 401);

  // Duplicate search query parameters are malformed input (400), not silently accepted.
  const dupQuery = await server.inject({ method: "GET", url: "/api/v1/cases?query=a&query=b", headers: { cookie: auth.cookie } });
  assert.equal(dupQuery.statusCode, 400);
  assert.deepEqual(decodeError(dupQuery), { code: "invalid_request", retryable: false });
});

test("bounded search pagination never ships the whole ledger through one response", async t => {
  const { server, engine } = await makeFixture();
  t.after(async () => { await server.close(); engine.close(); });
  const auth = await loginJson(server);

  // Seed 5 customers and 250 cases directly on the engine so the search is
  // measured against a ledger larger than any single page.
  const customerIds: CustomerId[] = [];
  for (let index = 0; index < 5; index += 1) {
    const receipt = engine.execute({ type: "CreateCustomer", displayName: `Bulk customer ${index}` });
    assert.ok(receipt.ok && receipt.customerId !== undefined);
    customerIds.push(receipt.customerId);
  }
  for (let index = 0; index < 250; index += 1) {
    const customerId = customerIds[index % customerIds.length]!;
    const receipt = engine.execute({ type: "CreateCase", customerId, title: `Bulk case ${index}` });
    assert.ok(receipt.ok);
  }

  // Page one is capped at MAX_CASE_LIST_ITEMS and carries a cursor.
  const first = await server.inject({ method: "GET", url: "/api/v1/cases", headers: { cookie: auth.cookie } });
  assert.equal(first.statusCode, 200);
  const pageOne = decodeCaseSearchResponse(first.json(), "$");
  assert.equal(pageOne.cases.length, MAX_CASE_LIST_ITEMS);
  assert.ok(pageOne.nextCursor);
  assert.equal(pageOne.nextCursor, MAX_CASE_LIST_ITEMS.toString(36));

  // Following the cursor returns the bounded remainder with no cursor at the end.
  const second = await server.inject({ method: "GET", url: `/api/v1/cases?cursor=${pageOne.nextCursor}`, headers: { cookie: auth.cookie } });
  assert.equal(second.statusCode, 200);
  const pageTwo = decodeCaseSearchResponse(second.json(), "$");
  assert.equal(pageTwo.cases.length, 50);
  assert.equal(pageTwo.nextCursor, undefined);

  const seen = new Set([...pageOne.cases, ...pageTwo.cases].map(item => item.caseId));
  assert.equal(seen.size, 250);
  assert.ok(!first.body.includes("auditEvents"));

  // Dashboard recent list and customer list are bounded as well.
  const dashboard = await server.inject({ method: "GET", url: "/api/v1/dashboard", headers: { cookie: auth.cookie } });
  const decodedDashboard = decodeDashboardResponse(dashboard.json(), "$");
  assert.equal(decodedDashboard.counts.customers, 5);
  assert.equal(decodedDashboard.counts.activeCases, 250);
  assert.equal(decodedDashboard.customers.length, Math.min(5, MAX_DASHBOARD_CUSTOMERS));
  assert.equal(decodedDashboard.recentCases.length, Math.min(250, MAX_DASHBOARD_RECENT_CASES));
});

test("retention uses the server clock and rejects out-of-range days", async t => {
  // Engine clock is 2026-09-04; the HTTP server clock is 2026-09-05. The purge
  // deadline must follow the server clock, never the engine or browser.
  const serverNow = Date.parse("2026-09-05T00:00:00.000Z");
  const { server, engine } = await makeFixture({}, 4, serverNow);
  t.after(async () => { await server.close(); engine.close(); });
  const auth = await loginJson(server);

  const customer = decodeCreateCustomerResponse(
    (await postJson(server, "/api/v1/customers", auth.cookie, auth.csrf, { displayName: "Acme" })).json(), "$",
  ).customer;
  const caseId = decodeCaseSummary(
    (await postJson(server, `/api/v1/customers/${customer.customerId}/cases`, auth.cookie, auth.csrf, { title: "Retention case" })).json(), "$",
  ).caseId;
  const grant = decodeCreateGrantResponse(
    (await postJson(server, `/api/v1/cases/${caseId}/grants`, auth.cookie, auth.csrf, { validForHours: 24, maxBytes: "2048" })).json(), "$",
  );
  const uploaded = await server.inject({
    method: "POST", url: "/api/v1/uploads",
    headers: { "content-type": "application/octet-stream", "x-upload-grant": parseUploadFragment(`#grant=${grant.uploadPath.split("#grant=")[1]}`) as string },
    payload: syntheticMinidump({ memoryListSizes: [8] }),
  });
  assert.equal(uploaded.statusCode, 201);
  const dumpId = decodeUploadCompleteResponse(uploaded.json(), "$").dumpId;

  // Retention PUT requires CSRF and a whole number of days within bounds.
  const noCsrf = await server.inject({
    method: "PUT", url: `/api/v1/dumps/${dumpId}/retention`,
    headers: { cookie: auth.cookie, "content-type": "application/json" },
    payload: JSON.stringify({ days: 2 }),
  });
  assert.equal(noCsrf.statusCode, 403);
  const zeroDays = await server.inject({
    method: "PUT", url: `/api/v1/dumps/${dumpId}/retention`,
    headers: jsonHeaders(auth.cookie, auth.csrf),
    payload: JSON.stringify({ days: 0 }),
  });
  assert.equal(zeroDays.statusCode, 400);
  assert.deepEqual(decodeError(zeroDays), { code: "invalid_request", retryable: false });
  const fractional = await server.inject({
    method: "PUT", url: `/api/v1/dumps/${dumpId}/retention`,
    headers: jsonHeaders(auth.cookie, auth.csrf),
    payload: JSON.stringify({ days: 1.5 }),
  });
  assert.equal(fractional.statusCode, 400);
  const oversized = await server.inject({
    method: "PUT", url: `/api/v1/dumps/${dumpId}/retention`,
    headers: jsonHeaders(auth.cookie, auth.csrf),
    payload: JSON.stringify({ days: 36501 }),
  });
  assert.equal(oversized.statusCode, 400);

  // A valid two-day retention derives its deadline from the server clock.
  const accepted = await server.inject({
    method: "PUT", url: `/api/v1/dumps/${dumpId}/retention`,
    headers: jsonHeaders(auth.cookie, auth.csrf),
    payload: JSON.stringify({ days: 2 }),
  });
  assert.equal(accepted.statusCode, 200);
  const decoded = decodeRetentionResponse(accepted.json(), "$");
  assert.equal(decoded.dump.purgeAt, "2026-09-07T00:00:00.000Z");
  assert.equal(engine.snapshot().dumps.find(dump => dump.dumpId === dumpId)?.purgeAt, "2026-09-07T00:00:00.000Z");
});

test("upload admission and grant decoding fail closed with stable status semantics", async t => {
  const admission = new UploadAdmission(1);
  const occupied = admission.tryAcquire();
  assert.ok(occupied);
  const { server, engine } = await makeFixture({ uploadAdmission: admission });
  t.after(async () => { await server.close(); engine.close(); });

  // Admission is full: even a structurally valid grant gets 503 upload_busy
  // before any grant or body is consumed.
  const busy = await server.inject({
    method: "POST", url: "/api/v1/uploads",
    headers: { "content-type": "application/octet-stream", "x-upload-grant": "s".repeat(43) },
    payload: Buffer.from("MDMP"),
  });
  assert.equal(busy.statusCode, 503);
  assert.deepEqual(decodeError(busy), { code: "upload_busy", retryable: true });
  occupied.release();

  // A malformed grant header is a 404 grant_unavailable without touching intake.
  const malformedGrant = await server.inject({
    method: "POST", url: "/api/v1/uploads",
    headers: { "content-type": "application/octet-stream", "x-upload-grant": "!!not-base64url!!" },
    payload: Buffer.from("MDMP"),
  });
  assert.equal(malformedGrant.statusCode, 404);
  assert.deepEqual(decodeError(malformedGrant), { code: "grant_unavailable", retryable: false });

  // A well-formed but unknown grant secret also fails closed as grant_unavailable.
  const unknownGrant = await server.inject({
    method: "POST", url: "/api/v1/uploads",
    headers: { "content-type": "application/octet-stream", "x-upload-grant": "u".repeat(43) },
    payload: Buffer.from("MDMP"),
  });
  assert.equal(unknownGrant.statusCode, 404);
  assert.deepEqual(decodeError(unknownGrant), { code: "grant_unavailable", retryable: false });
  assert.equal(engine.snapshot().dumps.length, 0);
});

test("upload oversize returns 413 without sealing bytes", async t => {
  const { server, engine } = await makeFixture({}, 4);
  t.after(async () => { await server.close(); engine.close(); });
  const auth = await loginJson(server);

  const customer = decodeCreateCustomerResponse(
    (await postJson(server, "/api/v1/customers", auth.cookie, auth.csrf, { displayName: "Acme" })).json(), "$",
  ).customer;
  const caseId = decodeCaseSummary(
    (await postJson(server, `/api/v1/customers/${customer.customerId}/cases`, auth.cookie, auth.csrf, { title: "Oversize case" })).json(), "$",
  ).caseId;
  const grant = decodeCreateGrantResponse(
    (await postJson(server, `/api/v1/cases/${caseId}/grants`, auth.cookie, auth.csrf, { validForHours: 24, maxBytes: "2048" })).json(), "$",
  );
  const secret = parseUploadFragment(`#${grant.uploadPath.split("#")[1]}`);
  assert.ok(secret);

  const oversized = await server.inject({
    method: "POST", url: "/api/v1/uploads",
    headers: { "content-type": "application/octet-stream", "x-upload-grant": secret },
    payload: Buffer.alloc(64 * 1024, 0x5a),
  });
  assert.equal(oversized.statusCode, 413);
  assert.deepEqual(decodeError(oversized), { code: "upload_too_large", retryable: false });
  // begin + fail records an audited rejected dump; the oversize bytes are never
  // sealed or promoted, so no dump is available or downloadable.
  const afterOversize = engine.snapshot();
  assert.equal(afterOversize.dumps.length, 1);
  assert.equal(afterOversize.dumps[0]?.phase, "rejected");
  assert.equal(afterOversize.dumps[0]?.byteSize, null);
  assert.ok(afterOversize.auditEvents.some(event => event.action === "FailUpload"));
});
