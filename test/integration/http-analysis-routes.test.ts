/**
 * Analyzer analysis write-back HTTP surface (docs/analyzer-integration-design.md,
 * "Analysis write-back"; milestone AI3 task I1):
 * `POST /api/v1/dumps/:dumpId/analyses` (201 fresh, 200 identity replay),
 * `GET /api/v1/dumps/:dumpId/analyses`, the new
 * `authorizeSessionOrAnalyzerMutation` guard precedence (bearer-only when an
 * `Authorization` header is present, session+CSRF otherwise), the per-dump
 * cap, and the stable error envelopes — all through the real engine, vault,
 * and Fastify stack, seeded by engine commands.
 */

import assert from "node:assert/strict";
import { bindRichFixture, richFixture } from "../../packages/http-contracts/test/rich-fixture.js";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  MAX_ANALYSES_PER_DUMP,
  decodeAnalysisListResponse,
  decodeAnalysisReport,
  decodeErrorResponse,
  decodeSessionResponse,
} from "@dump-ledger/http-contracts";
import { OperatorSessions, hashOperatorPassword } from "../../src/auth/sessions.js";
import { parseDumpId } from "../../src/domain/ids.js";
import { createDumpLedgerEngine, DeterministicClock, DeterministicEntropy, DeterministicIds } from "../../src/engine/dump-ledger-engine.js";
import { EngineHttpApplication } from "../../src/http/application.js";
import { buildHttpServer } from "../../src/http/server.js";
import { createVaultMinidumpInspectionPort } from "../../src/inspection/index.js";
import { EngineUploadLifecycle, EngineUploadPostProcessor, VaultUploadSink } from "../../src/intake/intake-facade.js";
import { MemoryVault } from "../../src/vault/memory-vault.js";
import { syntheticMinidump } from "../fixtures/minidump/synthetic-minidump.js";

const FIXED_NOW = "2026-09-16T08:00:00.000Z";
const EXPIRY = "2026-09-17T08:00:00.000Z";
const DUMP_BYTES = syntheticMinidump({ memoryListSizes: [8] });
const DUMP_SHA256 = createHash("sha256").update(DUMP_BYTES).digest("hex");
const ANALYZER_TOKEN = `analyzer-token-${"k".repeat(40)}`;
const ANALYZER_TOKEN_HASH = createHash("sha256").update(ANALYZER_TOKEN, "utf8").digest();
const UNKNOWN_DUMP_ID = "dump_00000000000000000000000000";

function deterministicSecrets(count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => `${"a".repeat(40)}${index.toString(36).padStart(4, "0")}`);
}

interface Fixture {
  readonly server: ReturnType<typeof buildHttpServer>;
  readonly engine: ReturnType<typeof createDumpLedgerEngine>;
  readonly vault: MemoryVault;
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
  assert.ok(csrf.length > 0);
  return { server, engine, vault, cookie, csrf };
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function mutationHeaders(fixture: Fixture): Record<string, string> {
  return { cookie: fixture.cookie, "x-csrf-token": fixture.csrf };
}

function errorCode(response: { json(): unknown }): string {
  return decodeErrorResponse(response.json(), "$").error.code;
}

/** One fresh issued grant over engine commands. */
function issueGrant(fixture: Fixture): string {
  const customer = fixture.engine.execute({ type: "CreateCustomer", displayName: "Acme" });
  assert.ok(customer.ok && customer.customerId !== undefined);
  const supportCase = fixture.engine.execute({ type: "CreateCase", customerId: customer.customerId, title: "Renderer crash" });
  assert.ok(supportCase.ok && supportCase.caseId !== undefined);
  const grant = fixture.engine.execute({ type: "IssueGrant", caseId: supportCase.caseId, expiresAt: EXPIRY, maxBytes: 1_000_000n });
  assert.ok(grant.ok && grant.grantSecret !== undefined);
  return grant.grantSecret;
}

/** One dump in phase `receiving` (staged bytes open, nothing sealed). */
function seedReceivingDump(fixture: Fixture): string {
  const begun = fixture.engine.execute({ type: "BeginUpload", grantSecret: issueGrant(fixture), originalName: "pending.dmp" });
  assert.ok(begun.ok && begun.dumpId !== undefined);
  return begun.dumpId;
}

/** One dump driven through the full lifecycle to `available` with real
 * minidump bytes in the vault and a sealed digest. */
function seedAvailableDump(fixture: Fixture): string {
  const begun = fixture.engine.execute({ type: "BeginUpload", grantSecret: issueGrant(fixture), originalName: "renderer.dmp" });
  assert.ok(begun.ok && begun.dumpId !== undefined);
  fixture.vault.append(begun.dumpId, DUMP_BYTES);
  fixture.vault.syncAndClose(begun.dumpId);
  assert.ok(fixture.engine.execute({ type: "SealUpload", dumpId: begun.dumpId, byteSize: BigInt(DUMP_BYTES.byteLength), sha256: DUMP_SHA256 }).ok);
  assert.ok(fixture.engine.execute({ type: "PromoteObject", dumpId: begun.dumpId }).ok);
  assert.ok(fixture.engine.execute({ type: "MarkQuarantined", dumpId: begun.dumpId }).ok);
  assert.ok(fixture.engine.execute({ type: "AcceptDump", dumpId: begun.dumpId }).ok);
  return begun.dumpId;
}

function analysisBody(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    analyzer: { name: "crash-triage", version: "1.2.3" },
    kind: "triage",
    inputSha256: DUMP_SHA256,
    outcome: "completed",
    summary: "Parsed the exception stream",
    ...overrides,
  };
}

async function postAnalysis(
  fixture: Fixture,
  dumpId: string,
  body: unknown,
  headers: Readonly<Record<string, string>> = bearer(ANALYZER_TOKEN),
) {
  return fixture.server.inject({
    method: "POST",
    url: `/api/v1/dumps/${dumpId}/analyses`,
    headers: { "content-type": "application/json", ...headers },
    payload: JSON.stringify(body),
  });
}

async function getAnalyses(
  fixture: Fixture,
  dumpId: string,
  headers: Readonly<Record<string, string>> = bearer(ANALYZER_TOKEN),
) {
  return fixture.server.inject({ method: "GET", url: `/api/v1/dumps/${dumpId}/analyses`, headers });
}

/* ------------------------------------------------------------------------ */

test("analyzer bearer records 201; an identity replay is 200 with one row", async t => {
  const fixture = await makeFixture({ analyzerTokenHash: ANALYZER_TOKEN_HASH });
  const { server, engine } = fixture;
  t.after(async () => { await server.close(); engine.close(); });

  const dumpId = seedAvailableDump(fixture);
  const body = analysisBody({ facts: { exceptionCode: 3221225477, modules: ["renderer.dll"] } });

  // Bearer only: no cookie, no CSRF token — a machine caller.
  const created = await postAnalysis(fixture, dumpId, body);
  assert.equal(created.statusCode, 201);
  assert.match(String(created.headers["content-type"]), /^application\/json/);
  assert.equal(created.headers["cache-control"], "no-store");
  const report = decodeAnalysisReport(created.json(), "$");
  assert.match(report.analysisId, /^analysis_[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.equal(report.dumpId, dumpId);
  assert.deepEqual(report.analyzer, { name: "crash-triage", version: "1.2.3" });
  assert.equal(report.kind, "triage");
  assert.equal(report.inputSha256, DUMP_SHA256);
  assert.equal(report.outcome, "completed");
  assert.equal(report.summary, "Parsed the exception stream");
  assert.deepEqual(report.facts, { exceptionCode: 3221225477, modules: ["renderer.dll"] });
  assert.equal(report.createdAt, FIXED_NOW);
  assert.ok(!("duplicateOf" in report), "a report without duplicateOf omits it");

  // Exact-identity replay: 200, same stored report, nothing new written.
  const replay = await postAnalysis(fixture, dumpId, body);
  assert.equal(replay.statusCode, 200);
  const replayedReport = decodeAnalysisReport(replay.json(), "$");
  assert.equal(replayedReport.analysisId, report.analysisId);
  assert.deepEqual(replayedReport, report);

  // The identity (not the body) is the key: a changed summary/outcome still
  // replays the stored report.
  const changed = await postAnalysis(fixture, dumpId, analysisBody({ summary: "second pass", outcome: "failed" }));
  assert.equal(changed.statusCode, 200);
  assert.deepEqual(decodeAnalysisReport(changed.json(), "$"), report);

  // Exactly one stored row, listed through the read route.
  const listed = await getAnalyses(fixture, dumpId);
  assert.equal(listed.statusCode, 200);
  const list = decodeAnalysisListResponse(listed.json(), "$");
  assert.equal(list.analyses.length, 1);
  assert.deepEqual(list.analyses[0], report);
  assert.equal(engine.listAnalyses(parseDumpId(dumpId)).length, 1);
});

test("write-back identity and state rejections map to the stable envelopes", async t => {
  const fixture = await makeFixture({ analyzerTokenHash: ANALYZER_TOKEN_HASH });
  const { server, engine } = fixture;
  t.after(async () => { await server.close(); engine.close(); });

  const dumpId = seedAvailableDump(fixture);

  // inputSha256 must equal the dump's sealed hash: 400, nothing stored.
  const mismatch = await postAnalysis(fixture, dumpId, analysisBody({ inputSha256: "b".repeat(64) }));
  assert.equal(mismatch.statusCode, 400);
  assert.equal(errorCode(mismatch), "invalid_request");
  assert.equal(engine.listAnalyses(parseDumpId(dumpId)).length, 0);

  // A dump that is not available (here: receiving) is invalid_transition.
  const receiving = seedReceivingDump(fixture);
  const notAvailable = await postAnalysis(fixture, receiving, analysisBody());
  assert.equal(notAvailable.statusCode, 409);
  assert.equal(errorCode(notAvailable), "invalid_transition");

  // Unknown dumps are 404 on both routes; a malformed id is not_found too.
  const missing = await postAnalysis(fixture, UNKNOWN_DUMP_ID, analysisBody());
  assert.equal(missing.statusCode, 404);
  assert.equal(errorCode(missing), "not_found");
  const missingList = await getAnalyses(fixture, UNKNOWN_DUMP_ID);
  assert.equal(missingList.statusCode, 404);
  assert.equal(errorCode(missingList), "not_found");
  const malformedList = await getAnalyses(fixture, "not-a-dump");
  assert.equal(malformedList.statusCode, 404);
  assert.equal(errorCode(malformedList), "not_found");

  // A well-formed available dump with no reports is an empty list, not 404.
  const emptyList = await getAnalyses(fixture, dumpId);
  assert.equal(emptyList.statusCode, 200);
  assert.deepEqual(decodeAnalysisListResponse(emptyList.json(), "$"), { analyses: [] });
});

test("write-back guard precedence: pinned bearer path, CSRF for sessions", async t => {
  const fixture = await makeFixture({ analyzerTokenHash: ANALYZER_TOKEN_HASH });
  const { server, engine } = fixture;
  t.after(async () => { await server.close(); engine.close(); });

  const dumpId = seedAvailableDump(fixture);

  // Wrong token + valid session+CSRF: the Authorization header selects the
  // bearer path only, so it is a 401, never a cookie/CSRF fallback.
  const wrongToken = await postAnalysis(fixture, dumpId, analysisBody(), {
    ...mutationHeaders(fixture),
    ...bearer("wrong-token"),
  });
  assert.equal(wrongToken.statusCode, 401);
  assert.equal(errorCode(wrongToken), "unauthenticated");

  // Malformed Authorization header + valid session: the same generic 401.
  const malformedHeader = await postAnalysis(fixture, dumpId, analysisBody(), {
    ...mutationHeaders(fixture),
    authorization: "Basic dXNlcjpwYXNz",
  });
  assert.equal(malformedHeader.statusCode, 401);
  assert.equal(errorCode(malformedHeader), "unauthenticated");

  // Anonymous JSON caller: 401 before any decode.
  const anonymous = await postAnalysis(fixture, dumpId, analysisBody(), {});
  assert.equal(anonymous.statusCode, 401);
  assert.equal(errorCode(anonymous), "unauthenticated");

  // Valid session without CSRF evidence: 403 (visible CSRF error, no logout).
  const noCsrf = await postAnalysis(fixture, dumpId, analysisBody(), { cookie: fixture.cookie });
  assert.equal(noCsrf.statusCode, 403);
  assert.equal(errorCode(noCsrf), "forbidden");

  // Session+CSRF is the operator path and needs no bearer token.
  const operator = await postAnalysis(fixture, dumpId, analysisBody({ kind: "operator-run" }), mutationHeaders(fixture));
  assert.equal(operator.statusCode, 201);

  // The read route still accepts both channels for the same dump.
  assert.equal((await getAnalyses(fixture, dumpId)).statusCode, 200);
  assert.equal((await getAnalyses(fixture, dumpId, { cookie: fixture.cookie })).statusCode, 200);
});

test("a disabled analyzer configuration rejects the bearer path with the generic 401", async t => {
  const fixture = await makeFixture();
  const { server, engine } = fixture;
  t.after(async () => { await server.close(); engine.close(); });

  const dumpId = seedAvailableDump(fixture);

  // Any Authorization header is 401 when DUMP_LEDGER_ANALYZER_TOKEN_HASH is
  // unset — even with a valid session cookie alongside it.
  const disabled = await postAnalysis(fixture, dumpId, analysisBody(), {
    ...mutationHeaders(fixture),
    ...bearer(ANALYZER_TOKEN),
  });
  assert.equal(disabled.statusCode, 401);
  assert.equal(errorCode(disabled), "unauthenticated");

  // Without the header the session mutation guard applies unchanged.
  const operator = await postAnalysis(fixture, dumpId, analysisBody(), mutationHeaders(fixture));
  assert.equal(operator.statusCode, 201);
});

test("GET list returns every report in (createdAt, analysisId) order", async t => {
  const fixture = await makeFixture({ analyzerTokenHash: ANALYZER_TOKEN_HASH });
  const { server, engine } = fixture;
  t.after(async () => { await server.close(); engine.close(); });

  const dumpId = seedAvailableDump(fixture);
  const firstBody = analysisBody({ kind: "classification", facts: { labels: ["gpu", "renderer"], nested: { ok: true } } });
  const secondBody = analysisBody({ kind: "symbolication", outcome: "failed", summary: "Missing PDBs", duplicateOf: dumpId });

  const first = await postAnalysis(fixture, dumpId, firstBody);
  assert.equal(first.statusCode, 201);
  const firstReport = decodeAnalysisReport(first.json(), "$");
  const second = await postAnalysis(fixture, dumpId, secondBody);
  assert.equal(second.statusCode, 201);
  const secondReport = decodeAnalysisReport(second.json(), "$");
  assert.equal(secondReport.duplicateOf, dumpId);

  const listed = await getAnalyses(fixture, dumpId);
  assert.equal(listed.statusCode, 200);
  const list = decodeAnalysisListResponse(listed.json(), "$");
  assert.equal(list.analyses.length, 2);
  // The deterministic clock pins createdAt; analysisId breaks the tie, so the
  // list is creation order.
  assert.deepEqual(list.analyses[0], firstReport);
  assert.deepEqual(list.analyses[1], secondReport);
  assert.deepEqual(list.analyses[0]?.facts, { labels: ["gpu", "renderer"], nested: { ok: true } });
  assert.ok(!("facts" in secondReport), "a report without facts omits them");
});

test("the per-dump cap admits MAX_ANALYSES_PER_DUMP identities and rejects the next", async t => {
  const fixture = await makeFixture({ analyzerTokenHash: ANALYZER_TOKEN_HASH });
  const { server, engine } = fixture;
  t.after(async () => { await server.close(); engine.close(); });

  const dumpId = seedAvailableDump(fixture);
  for (let index = 0; index < MAX_ANALYSES_PER_DUMP; index += 1) {
    const response = await postAnalysis(fixture, dumpId, analysisBody({ kind: `bulk-${index}` }));
    assert.equal(response.statusCode, 201, `bulk-${index} must be recorded`);
  }
  const stored = engine.listAnalyses(parseDumpId(dumpId));
  assert.equal(stored.length, MAX_ANALYSES_PER_DUMP);

  // A 65th distinct identity is refused with the stable invalid_transition
  // envelope and writes nothing.
  const overflow = await postAnalysis(fixture, dumpId, analysisBody({ kind: "one-too-many" }));
  assert.equal(overflow.statusCode, 409);
  assert.equal(errorCode(overflow), "invalid_transition");
  assert.equal(engine.listAnalyses(parseDumpId(dumpId)).length, MAX_ANALYSES_PER_DUMP);

  // A replay stores nothing new, so it stays admissible at the cap — the
  // analyzer's retry-after-lost-response path must not be turned away.
  const replay = await postAnalysis(fixture, dumpId, analysisBody({ kind: "bulk-0" }));
  assert.equal(replay.statusCode, 200);
  const original = stored.find(candidate => candidate.kind === "bulk-0");
  assert.ok(original !== undefined);
  assert.equal(decodeAnalysisReport(replay.json(), "$").analysisId, original.analysisId);
  assert.equal(engine.listAnalyses(parseDumpId(dumpId)).length, MAX_ANALYSES_PER_DUMP);

  const listed = await getAnalyses(fixture, dumpId);
  assert.equal(listed.statusCode, 200);
  assert.equal(decodeAnalysisListResponse(listed.json(), "$").analyses.length, MAX_ANALYSES_PER_DUMP);
});

test("malformed write-back bodies are invalid_request before any engine work", async t => {
  const fixture = await makeFixture({ analyzerTokenHash: ANALYZER_TOKEN_HASH });
  const { server, engine } = fixture;
  t.after(async () => { await server.close(); engine.close(); });

  const dumpId = seedAvailableDump(fixture);
  const base = analysisBody();
  const malformed: ReadonlyArray<readonly [string, unknown]> = [
    ["kind is not a string", { ...base, kind: 42 }],
    ["kind is empty", { ...base, kind: "" }],
    ["kind exceeds 64 characters", { ...base, kind: "k".repeat(65) }],
    ["summary exceeds 2000 characters", { ...base, summary: "s".repeat(2001) }],
    ["facts exceed 4096 serialized bytes", { ...base, facts: { blob: "x".repeat(4200) } }],
    ["analyzer.version is not a string", { ...base, analyzer: { name: "crash-triage", version: 7 } }],
    ["unexpected field", { ...base, verdict: "crash" }],
  ];
  for (const [label, body] of malformed) {
    const response = await postAnalysis(fixture, dumpId, body, mutationHeaders(fixture));
    assert.equal(response.statusCode, 400, label);
    assert.equal(errorCode(response), "invalid_request", label);
  }
  assert.equal(engine.listAnalyses(parseDumpId(dumpId)).length, 0);

  // The well-formed control body still records after every rejection.
  const control = await postAnalysis(fixture, dumpId, base, mutationHeaders(fixture));
  assert.equal(control.statusCode, 201);
});

test("v2 preserves full bytes beyond v1 limit, authenticates detail reads, and promotes summary", async t => {
  const fixture = await makeFixture({ analyzerTokenHash: ANALYZER_TOKEN_HASH }); t.after(async () => { await fixture.server.close(); fixture.engine.close(); });
  const dumpId = seedAvailableDump(fixture), { document } = richFixture(dumpId, DUMP_SHA256);
  (document.evidence as Array<Record<string, unknown>>)[0]!.text = "e".repeat(8192);
  (document.completeness as Record<string, unknown>).omissions = ["x".repeat(8192), "y".repeat(8192)];
  const body = bindRichFixture(document), { reportJson, reportDigest, ...summary } = body;
  const cap = await fixture.server.inject({ method: "GET", url: "/api/v2/capabilities", headers: bearer(ANALYZER_TOKEN) });
  assert.equal(cap.statusCode, 200); assert.equal(cap.json().richReports.maxReportBytes, 524288);
  assert.equal((await fixture.server.inject({ method: "GET", url: "/api/v2/capabilities" })).statusCode, 401);
  const first = await postAnalysis(fixture, dumpId, summary); assert.equal(first.statusCode, 201); const analysisId = first.json().analysisId as string;
  const post = () => fixture.server.inject({ method: "POST", url: `/api/v2/dumps/${dumpId}/analyses`, headers: { "content-type": "application/json", ...bearer(ANALYZER_TOKEN) }, payload: JSON.stringify(body) });
  const promoted = await post(); assert.equal(promoted.statusCode, 201, promoted.body); assert.equal(promoted.json().analysisId, analysisId);
  assert.equal(promoted.json().reportJson, reportJson); assert.equal(promoted.json().reportDigest, reportDigest);
  const replay = await post(); assert.equal(replay.statusCode, 200);
  const path = `/api/v2/dumps/${dumpId}/analyses/${analysisId}`;
  assert.equal((await fixture.server.inject({ method: "GET", url: path })).statusCode, 401);
  const read = await fixture.server.inject({ method: "GET", url: path, headers: bearer(ANALYZER_TOKEN) }); assert.equal(read.statusCode, 200); assert.equal(read.json().reportJson, reportJson);
  const list = await getAnalyses(fixture, dumpId); assert.equal(list.json().analyses.length, 1); assert.equal(list.json().analyses[0].reportJson, undefined);
  const changed = richFixture(dumpId, DUMP_SHA256); changed.document.completeness = { omissions: ["changed"], truncated: false };
  const conflict = await fixture.server.inject({ method: "POST", url: `/api/v2/dumps/${dumpId}/analyses`, headers: { "content-type": "application/json", ...bearer(ANALYZER_TOKEN) }, payload: JSON.stringify(bindRichFixture(changed.document)) }); assert.equal(conflict.statusCode, 409);
});

test("v2 rejects invalid hash/identity/references and request overflow without writes", async t => {
  const fixture = await makeFixture({ analyzerTokenHash: ANALYZER_TOKEN_HASH }); t.after(async () => { await fixture.server.close(); fixture.engine.close(); });
  const dumpId = seedAvailableDump(fixture), { request } = richFixture(dumpId, DUMP_SHA256);
  const path = `/api/v2/dumps/${dumpId}/analyses`;
  for (const body of [ { ...request, reportDigest: "b".repeat(64), facts: { ...request.facts, reportDigest: "b".repeat(64) } }, { ...request, reportJson: request.reportJson.replace(dumpId, UNKNOWN_DUMP_ID) }, { ...request, reportJson: request.reportJson.replace('"evidenceRefs":["exception"]', '"evidenceRefs":["fabricated"]') } ]) {
    const response = await fixture.server.inject({ method: "POST", url: path, headers: { "content-type": "application/json", ...bearer(ANALYZER_TOKEN) }, payload: JSON.stringify(body) }); assert.equal(response.statusCode, 400, response.body);
  }
  const oversized = await fixture.server.inject({ method: "POST", url: path, headers: { "content-type": "application/json", ...bearer(ANALYZER_TOKEN) }, payload: "x".repeat(1048577) }); assert.equal(oversized.statusCode, 413);
  assert.deepEqual(fixture.engine.listAnalyses(parseDumpId(dumpId)), []);
});
