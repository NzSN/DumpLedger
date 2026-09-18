import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CASE_ACTIONS,
  CASE_STATUSES,
  COVERAGE_KINDS,
  DecodeError,
  DUMP_PHASES,
  GRANT_STATES,
  HTTP_ERROR_CODES,
  MAX_SYMBOL_BYTES,
  MAX_SYMBOL_FILENAME_LENGTH,
  SYMBOL_KINDS,
  SYMBOLS_PATH,
  VALIDATION_STATES,
  X_SYMBOL_FILENAME_HEADER,
  decodeCaseDetailResponse,
  decodeCaseSearchParams,
  decodeCaseSummary,
  decodeCaseSearchResponse,
  decodeCreateCaseRequest,
  decodeCreateCaseResponse,
  decodeCreateCustomerRequest,
  decodeCreateCustomerResponse,
  decodeCustomerDetailResponse,
  decodeCreateGrantRequest,
  decodeGrantQuotaResponse,
  decodeCreateGrantResponse,
  decodeDashboardResponse,
  decodeDumpDetailResponse,
  decodeErrorResponse,
  decodeFilenameBase64url,
  decodeGrantRecord,
  decodeHealthResponse,
  decodeJsonText,
  decodeLoginRequest,
  decodeOperationsResponse,
  decodeRetentionRequest,
  decodeRetentionResponse,
  decodeRevokeGrantResponse,
  decodeSessionResponse,
  decodeSymbolFilenameBase64url,
  decodeSymbolIngestResponse,
  decodeSymbolListResponse,
  decodeSymbolRecord,
  decodeTransitionRequest,
  decodeTransitionResponse,
  decodeUploadCompleteResponse,
  decodeUploadGrantSecret,
  decodeUploadPath,
  decodeUploadQueuedResponse,
  encodeCaseDetailResponse,
  encodeCaseSearchResponse,
  encodeCreateCaseRequest,
  encodeCreateCaseResponse,
  encodeCreateCustomerRequest,
  encodeCustomerDetailResponse,
  encodeCreateCustomerResponse,
  encodeCreateGrantRequest,
  encodeGrantQuotaResponse,
  encodeCreateGrantResponse,
  encodeDashboardResponse,
  encodeDumpDetailResponse,
  encodeErrorResponse,
  encodeFilenameBase64url,
  encodeGrantRecord,
  encodeHealthResponse,
  encodeLoginRequest,
  encodeOperationsResponse,
  encodeRetentionRequest,
  encodeRetentionResponse,
  encodeRevokeGrantResponse,
  encodeSessionResponse,
  encodeSymbolFilenameBase64url,
  encodeSymbolIngestResponse,
  encodeSymbolListResponse,
  encodeSymbolRecord,
  encodeTransitionRequest,
  encodeTransitionResponse,
  encodeUploadCompleteResponse,
  encodeUploadQueuedResponse,
  parseUploadFragment,
  symbolPathForArtifact,
  toJsonText,
  type Decoder,
  type CaseDetailResponse,
  type CustomerDetailResponse,
  type CaseDumpSummary,
  type CaseGrantSummary,
  type CaseSearchResponse,
  type CaseSummary,
  type CreateCustomerResponse,
  type DashboardResponse,
  type DumpDetailResponse,
  type ErrorResponse,
  type LoginRequest,
  type MissingSymbolIdentity,
  type ModuleSymbolCoverage,
  type OperationsResponse,
  type RetentionRequest,
  type RetentionResponse,
  type SessionResponse,
  type SymbolIngestResponse,
  type SymbolListResponse,
  type SymbolRecord,
  type TransitionRequest,
  type TransitionResponse,
  type UploadCompleteResponse,
  type UploadQueuedResponse,
} from "../src/index.js";

const ID_CASE = "case_01JTEST0000000000000000000";
const ID_CUSTOMER = "customer_01JTEST0000000000000000000";
const ID_GRANT = "grant_01JTEST0000000000000000000";
const ID_DUMP = "dump_01JTEST0000000000000000000";
const ID_DUMP_B = "dump_01JTEST0000000000000000001";
const ID_SYMBOL_COVERAGE = "symbol_01JTEST0000000000000000001";
const DEBUG_FILE = "electron.pdb";
const DEBUG_ID = "3A9C1F2E4B5D6789012345678ABCDEF1";

const NOW = "2026-01-15T10:30:00.123Z";
const LATER = "2026-02-14T10:30:00.000Z";

function expectDecodeError(fn: () => unknown, pattern: RegExp): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof DecodeError, `expected DecodeError, got ${String(error)}`);
    assert.match((error as DecodeError).message, pattern);
    return true;
  });
}

function roundTripJson<T>(
  value: T,
  encode: (value: T) => Record<string, unknown>,
  decode: Decoder<T>,
): T {
  const jsonText = toJsonText(encode(value));
  return decodeJsonText(jsonText, decode);
}

describe("wire vocabularies", () => {
  it("uses the exact TLA+/generated-port CaseAction names", () => {
    assert.deepEqual([...CASE_ACTIONS], [
      "StartInvestigation",
      "WaitForCustomer",
      "ResumeInvestigation",
      "ResolveCase",
      "CloseCase",
    ]);
  });
  it("mirrors the domain status vocabularies", () => {
    assert.deepEqual([...CASE_STATUSES], ["new", "investigating", "waiting-for-customer", "resolved", "closed"]);
    assert.deepEqual([...GRANT_STATES], ["issued", "consumed", "revoked", "expired"]);
    assert.deepEqual(
      [...DUMP_PHASES],
      ["receiving", "sealed", "quarantined", "available", "rejected", "deleting", "deleted"],
    );
    assert.deepEqual([...VALIDATION_STATES], ["not-checked", "valid", "invalid", "transfer-failed"]);
    assert.deepEqual([...COVERAGE_KINDS], ["partial", "full-memory-declared", "unknown"]);
  });
  it("exposes the stable HTTP error codes", () => {
    assert.deepEqual([...HTTP_ERROR_CODES], [
      "invalid_request",
      "unauthenticated",
      "forbidden",
      "not_found",
      "invalid_transition",
      "grant_unavailable",
      "grant_slots_exhausted",
      "upload_too_large",
      "upload_busy",
      "symbol_identity_unreadable",
      "symbol_kind_unsupported",
      "symbol_too_large",
      "rate_limited",
      "storage_unavailable",
      "integrity_failure",
      "internal_error",
    ]);
  });
});

describe("error envelope (7.1)", () => {
  const sample: ErrorResponse = {
    error: { code: "invalid_transition", message: "The case cannot transition now.", retryable: false },
  };
  it("round-trips every stable code with a safe message", () => {
    for (const code of HTTP_ERROR_CODES) {
      const value: ErrorResponse = { error: { code, message: `safe ${code} message`, retryable: code === "upload_busy" } };
      assert.deepEqual(roundTripJson(value, encodeErrorResponse, decodeErrorResponse), value);
    }
  });
  it("rejects unknown error codes", () => {
    expectDecodeError(
      () => decodeErrorResponse({ error: { code: "grant_invalid", message: "x", retryable: false } }, "$"),
      /error code is invalid/,
    );
  });
  it("keeps messages safe: bounded length and no control characters", () => {
    expectDecodeError(
      () => decodeErrorResponse({ error: { code: "not_found", message: "x".repeat(301), retryable: false } }, "$"),
      /exceeds 300 characters/,
    );
    expectDecodeError(
      () => decodeErrorResponse({ error: { code: "not_found", message: "bad\nmessage", retryable: false } }, "$"),
      /contains control characters/,
    );
    // Paths and secrets are rejected at the producer boundary (safe-message
    // policy); the decoder enforces the enforceable part: bounded, single-line,
    // control-character-free text.
    assert.equal(decodeErrorResponse({ error: { code: "not_found", message: "Not found", retryable: false } }, "$").error.message, "Not found");
  });
  it("rejects a missing, extra, or wrong-typed envelope field", () => {
    expectDecodeError(() => decodeErrorResponse({ error: { code: "not_found", retryable: false } }, "$"), /missing required field/);
    expectDecodeError(() => decodeErrorResponse({ error: { code: "not_found", message: "x", retryable: false, extra: 1 } }, "$"), /unexpected field/);
    expectDecodeError(() => decodeErrorResponse({ error: { code: "not_found", message: "x", retryable: "no" } }, "$"), /must be a boolean/);
  });
});

describe("authentication (7.2)", () => {
  const session: SessionResponse = { authenticated: true, csrfToken: "csrf-abc-123", expiresAt: LATER };
  const loggedOut: SessionResponse = { authenticated: false };

  it("round-trips the login request", () => {
    const request: LoginRequest = { password: "correct horse battery staple" };
    assert.deepEqual(roundTripJson(request, encodeLoginRequest, decodeLoginRequest), request);
  });
  it("round-trips an authenticated session and an unauthenticated session", () => {
    assert.deepEqual(roundTripJson(session, encodeSessionResponse, decodeSessionResponse), session);
    assert.deepEqual(roundTripJson(loggedOut, encodeSessionResponse, decodeSessionResponse), loggedOut);
  });
  it("rejects an authenticated session missing csrfToken or expiresAt", () => {
    expectDecodeError(() => decodeSessionResponse({ authenticated: true, csrfToken: "t" }, "$"), /missing required field/);
    expectDecodeError(() => decodeSessionResponse({ authenticated: true, expiresAt: LATER }, "$"), /missing required field/);
  });
  it("rejects an unauthenticated session that carries a token or expiry", () => {
    expectDecodeError(() => decodeSessionResponse({ authenticated: false, csrfToken: "t" }, "$"), /must be absent/);
    expectDecodeError(() => decodeSessionResponse({ authenticated: false, expiresAt: LATER }, "$"), /must be absent/);
  });
  it("rejects malformed and wrong-typed login bodies", () => {
    expectDecodeError(() => decodeLoginRequest({}, "$"), /missing required field/);
    expectDecodeError(() => decodeLoginRequest({ password: 42 }, "$"), /must be a string/);
    expectDecodeError(() => decodeLoginRequest({ password: "ok", remember: true }, "$"), /unexpected field/);
  });
  it("rejects a whitespace-bearing csrf token", () => {
    expectDecodeError(() => decodeSessionResponse({ authenticated: true, csrfToken: "a b", expiresAt: LATER }, "$"), /malformed/);
  });
});

describe("customers and dashboard (7.3)", () => {
  const created: CreateCustomerResponse = { customer: { customerId: ID_CUSTOMER, displayName: "Acme Corp" } };
  const dashboard: DashboardResponse = {
    counts: { customers: 3, activeCases: 2, availableDumps: 5, processingDumps: 1 },
    customers: [{ customerId: ID_CUSTOMER, displayName: "Acme Corp" }],
    recentCases: [
      { caseId: ID_CASE, customerId: ID_CUSTOMER, title: "Crash on 1.4.2", status: "investigating", createdAt: NOW },
    ],
  };

  it("round-trips create customer request and response", () => {
    const request = { displayName: "Acme Corp" };
    assert.deepEqual(roundTripJson(request, encodeCreateCustomerRequest, decodeCreateCustomerRequest), request);
    assert.deepEqual(roundTripJson(created, encodeCreateCustomerResponse, decodeCreateCustomerResponse), created);
  });
  it("round-trips the dashboard response and enforces its bounds", () => {
    assert.deepEqual(roundTripJson(dashboard, encodeDashboardResponse, decodeDashboardResponse), dashboard);
    const tooMany = {
      ...dashboard,
      recentCases: Array.from({ length: 21 }, (_, index) => ({
        caseId: `case_${index}`,
        customerId: ID_CUSTOMER,
        title: `t${index}`,
        status: "new" as const,
        createdAt: NOW,
      })),
    };
    expectDecodeError(() => decodeDashboardResponse(tooMany, "$"), /recentCases exceeds 20 items/);
  });
  it("rejects missing, extra, and wrong-typed customer rows", () => {
    expectDecodeError(() => decodeCustomerRow({ displayName: "No id" }), /missing required field/);
    expectDecodeError(() => decodeCustomerRow({ customerId: ID_CUSTOMER, displayName: "x", extra: true }), /unexpected field/);
    expectDecodeError(() => decodeCustomerRow({ customerId: 5, displayName: "x" }), /must be a string/);
  });
  it("rejects non-integer counts", () => {
    expectDecodeError(() => decodeDashboardResponse({ ...dashboard, counts: { ...dashboard.counts, customers: 1.5 } }, "$"), /safe integer/);
  });
});

function decodeCustomerRow(value: unknown): void {
  decodeDashboardResponse({ counts: { customers: 1, activeCases: 0, availableDumps: 0, processingDumps: 0 }, customers: [value], recentCases: [] }, "$");
}

describe("cases (7.3/7.4)", () => {
  const summary: CaseSummary = {
    caseId: ID_CASE,
    customerId: ID_CUSTOMER,
    title: "Crash on 1.4.2",
    status: "investigating",
    createdAt: NOW,
  };
  const grantRow: CaseGrantSummary = {
    grantId: ID_GRANT,
    state: "issued",
    createdAt: NOW,
    expiresAt: LATER,
    maxBytes: 1024n * 1024n * 1024n,
    maxUploads: 4,
    uploadsUsed: 2,
  };
  const dumpRow: CaseDumpSummary = {
    dumpId: ID_DUMP,
    phase: "available",
    originalName: "crash.dmp",
    byteSize: null,
    receivedAt: NOW,
  };
  const missingSymbol: MissingSymbolIdentity = {
    debugFile: "gpu.pdb",
    debugId: "4B5D6789012345678ABCDEF13A9C1F2E",
    dumpIds: [ID_DUMP, ID_DUMP_B],
  };
  const detail: CaseDetailResponse = {
    caseId: ID_CASE,
    customerId: ID_CUSTOMER,
    title: "Crash on 1.4.2",
    status: "investigating",
    createdAt: NOW,
    customer: { customerId: ID_CUSTOMER, displayName: "Acme Corp" },
    allowedActions: ["StartInvestigation", "WaitForCustomer", "ResumeInvestigation", "ResolveCase", "CloseCase"],
    grants: [grantRow],
    dumps: [dumpRow],
    missingSymbols: [missingSymbol],
    activity: [{ occurredAt: NOW, action: "CaseCreated", outcome: "created" }],
  };

  it("round-trips create-case and case summaries", () => {
    const request = { title: "Crash on 1.4.2" };
    assert.deepEqual(roundTripJson(request, encodeCreateCaseRequest, decodeCreateCaseRequest), request);
    assert.deepEqual(roundTripJson(summary, encodeCreateCaseResponse, decodeCreateCaseResponse), summary);
  });
  it("round-trips the case detail response", () => {
    const decoded = roundTripJson(detail, encodeCaseDetailResponse, decodeCaseDetailResponse);
    assert.deepEqual(decoded, detail);
    assert.equal(decoded.grants[0]?.maxBytes, 1024n * 1024n * 1024n);
  });
  it("bounds the aggregated missing symbol identities", () => {
    const encoded = encodeCaseDetailResponse(detail);
    assert.deepEqual(encoded.missingSymbols, [
      { debugFile: "gpu.pdb", debugId: missingSymbol.debugId, dumpIds: [ID_DUMP, ID_DUMP_B] },
    ]);
    expectDecodeError(
      () => decodeCaseDetailResponse({
        ...encoded,
        missingSymbols: [{ debugFile: "gpu.pdb", debugId: "x".repeat(65), dumpIds: [ID_DUMP] }],
      }, "$"),
      /debugId exceeds 64 characters/,
    );
    expectDecodeError(
      () => decodeCaseDetailResponse({
        ...encoded,
        missingSymbols: [{ debugFile: "gpu.pdb", debugId: missingSymbol.debugId, dumpIds: [7] }],
      }, "$"),
      /dumpId must be a string/,
    );
  });
  it("keeps bigint byte sizes as canonical decimal strings on the wire", () => {
    const encoded = encodeCaseDetailResponse(detail);
    const grants = encoded.grants as Array<{ maxBytes: unknown }>;
    const dumps = encoded.dumps as Array<{ byteSize: unknown }>;
    assert.equal(typeof grants[0]?.maxBytes, "string");
    assert.equal(grants[0]?.maxBytes, (1024n * 1024n * 1024n).toString());
    assert.equal(dumps[0]?.byteSize, null);
    const withSize: CaseDumpSummary = { ...dumpRow, byteSize: 4096n };
    const json = toJsonText(encodeCaseDetailResponse({ ...detail, dumps: [withSize] }));
    assert.match(json, /"byteSize":"4096"/);
  });
  it("round-trips search params and rejects duplicates", () => {
    assert.deepEqual(decodeCaseSearchParams({}), {});
    assert.deepEqual(decodeCaseSearchParams({ query: "crash" }), { query: "crash" });
    assert.deepEqual(decodeCaseSearchParams({ cursor: "abc" }), { cursor: "abc" });
    assert.deepEqual(decodeCaseSearchParams({ query: "", cursor: "opaque-cursor" }), { query: "", cursor: "opaque-cursor" });
    expectDecodeError(() => decodeCaseSearchParams({ query: ["a", "b"] }), /at most once/);
    expectDecodeError(() => decodeCaseSearchParams({ cursor: ["a", "b"] }), /at most once/);
    expectDecodeError(() => decodeCaseSearchParams({ cursor: "has space" }), /malformed/);
  });
  it("round-trips the case search response and enforces its bounds", () => {
    const response: CaseSearchResponse = { cases: [summary], nextCursor: "opaque-cursor" };
    assert.deepEqual(roundTripJson(response, encodeCaseSearchResponse, decodeCaseSearchResponse), response);
    expectDecodeError(
      () => decodeCaseSearchResponse({ cases: [], nextCursor: 42 }, "$"),
      /nextCursor must be a string/,
    );
  });
  it("rejects missing, extra, malformed, oversized, and wrong-typed case data", () => {
    expectDecodeError(() => decodeCaseSummary({ customerId: ID_CUSTOMER, title: "t", status: "new", createdAt: NOW }, "$"), /missing required field/);
    expectDecodeError(() => decodeCaseSummary({ ...summary, unexpected: true }, "$"), /unexpected field/);
    expectDecodeError(() => decodeCaseSummary({ ...summary, status: "not-a-status" }, "$"), /case status is invalid/);
    expectDecodeError(() => decodeCaseSummary({ ...summary, title: "x".repeat(301) }, "$"), /exceeds 300 characters/);
    expectDecodeError(() => decodeCaseSummary({ ...summary, createdAt: "2026-01-15T10:30:00+00:00" }, "$"), /not a canonical UTC timestamp/);
    expectDecodeError(() => decodeCaseSummary({ ...summary, caseId: 42 }, "$"), /must be a string/);
  });
});

describe("case transitions (7.4)", () => {
  const transition: TransitionRequest = { action: "StartInvestigation" };
  const closeResponse: TransitionResponse = {
    caseId: ID_CASE,
    action: "CloseCase",
    status: "closed",
    occurredAt: NOW,
    revokedGrants: { count: 2, grantIds: [ID_GRANT, "grant_01JTEST0000000000000000001"] },
  };
  const plainResponse: TransitionResponse = {
    caseId: ID_CASE,
    action: "ResolveCase",
    status: "resolved",
    occurredAt: NOW,
  };

  it("round-trips the transition request and both response shapes", () => {
    assert.deepEqual(roundTripJson(transition, encodeTransitionRequest, decodeTransitionRequest), transition);
    assert.deepEqual(roundTripJson(closeResponse, encodeTransitionResponse, decodeTransitionResponse), closeResponse);
    assert.deepEqual(roundTripJson(plainResponse, encodeTransitionResponse, decodeTransitionResponse), plainResponse);
  });
  it("rejects an illegal action name", () => {
    expectDecodeError(() => decodeTransitionRequest({ action: "ReopenCase" }, "$"), /case action is invalid/);
  });
  it("requires CloseCase to report atomically revoked grants", () => {
    expectDecodeError(
      () => decodeTransitionResponse({ caseId: ID_CASE, action: "CloseCase", status: "closed", occurredAt: NOW }, "$"),
      /missing required revoked-grant summary/,
    );
  });
  it("rejects revokedGrants on a non-CloseCase action", () => {
    expectDecodeError(
      () => decodeTransitionResponse({ ...plainResponse, revokedGrants: { count: 0, grantIds: [] } }, "$"),
      /only valid for CloseCase/,
    );
  });
  it("rejects a count that does not match the grant identifiers", () => {
    expectDecodeError(
      () =>
        decodeTransitionResponse(
          { caseId: ID_CASE, action: "CloseCase", status: "closed", occurredAt: NOW, revokedGrants: { count: 3, grantIds: [ID_GRANT] } },
          "$",
        ),
      /count must match/,
    );
  });
});

describe("customer detail panel", () => {
  const detail: CustomerDetailResponse = {
    customer: { customerId: ID_CUSTOMER, displayName: "Acme Corp", createdAt: NOW },
    cases: [
      {
        caseId: ID_CASE,
        customerId: ID_CUSTOMER,
        title: "Crash on 1.4.2",
        status: "investigating",
        createdAt: NOW,
      },
    ],
  };
  it("round-trips the customer detail response", () => {
    assert.deepEqual(roundTripJson(detail, encodeCustomerDetailResponse, decodeCustomerDetailResponse), detail);
  });
  it("rejects a non-canonical createdAt on the customer record", () => {
    expectDecodeError(
      () => decodeCustomerDetailResponse(
        { customer: { ...detail.customer, createdAt: "yesterday" }, cases: [] },
        "$",
      ),
      /canonical/,
    );
  });
});

describe("grants (7.5)", () => {
  const secret = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-";
  const request = { validForHours: 72, maxBytes: 268_435_456n };
  const grant = {
    grantId: ID_GRANT,
    caseId: ID_CASE,
    state: "issued" as const,
    createdAt: NOW,
    expiresAt: LATER,
    maxBytes: 268_435_456n,
    maxUploads: 3,
    uploadsUsed: 1,
  };
  const created = { grant, uploadPath: `/upload#grant=${secret}` };
  const revoked = { grant: { ...grant, state: "revoked" as const } };

  it("round-trips create-grant request with a canonical decimal maxBytes", () => {
    assert.deepEqual(roundTripJson(request, encodeCreateGrantRequest, decodeCreateGrantRequest), request);
    const json = toJsonText(encodeCreateGrantRequest(request));
    assert.match(json, /"maxBytes":"268435456"/);
  });
  it("round-trips a batch grant request and omits maxUploads for one-time grants", () => {
    const batch = { validForHours: 72, maxBytes: 268_435_456n, maxUploads: 5 };
    assert.deepEqual(roundTripJson(batch, encodeCreateGrantRequest, decodeCreateGrantRequest), batch);
    // A one-time grant encodes byte-identically to the pre-batch contract.
    const oneTime = { validForHours: 72, maxBytes: 268_435_456n };
    assert.deepEqual(roundTripJson(oneTime, encodeCreateGrantRequest, decodeCreateGrantRequest), oneTime);
    assert.deepEqual(encodeCreateGrantRequest({ ...oneTime, maxUploads: 1 }), encodeCreateGrantRequest(oneTime));
    assert.ok(!("maxUploads" in encodeCreateGrantRequest(oneTime)));
  });
  it("bounds maxUploads to 1..16", () => {
    expectDecodeError(() => decodeCreateGrantRequest({ validForHours: 72, maxBytes: "1", maxUploads: 0 }, "$"), /below the minimum/);
    expectDecodeError(() => decodeCreateGrantRequest({ validForHours: 72, maxBytes: "1", maxUploads: 17 }, "$"), /exceeds the maximum/);
    expectDecodeError(() => decodeCreateGrantRequest({ validForHours: 72, maxBytes: "1", maxUploads: 2.5 }, "$"), /safe integer/);
  });
  it("defaults grant record slot fields for a pre-batch server", () => {
    const decoded = decodeGrantRecord(
      { grantId: ID_GRANT, caseId: ID_CASE, state: "issued", createdAt: NOW, expiresAt: LATER, maxBytes: "268435456" },
      "$",
    );
    assert.equal(decoded.maxUploads, 1);
    assert.equal(decoded.uploadsUsed, 0);
  });
  it("round-trips the grant quota response", () => {
    const quota = { maxUploads: 5, uploadsUsed: 2, maxBytes: 268_435_456n, expiresAt: LATER };
    assert.deepEqual(roundTripJson(quota, encodeGrantQuotaResponse, decodeGrantQuotaResponse), quota);
    expectDecodeError(
      () => decodeGrantQuotaResponse({ maxUploads: 0, uploadsUsed: 0, maxBytes: "1", expiresAt: LATER }, "$"),
      /below the minimum/,
    );
  });
  it("rejects non-string and non-canonical maxBytes", () => {
    expectDecodeError(() => decodeCreateGrantRequest({ validForHours: 72, maxBytes: 268435456 }, "$"), /must be a string/);
    expectDecodeError(() => decodeCreateGrantRequest({ validForHours: 72, maxBytes: "268435456.0" }, "$"), /canonical decimal string/);
    expectDecodeError(() => decodeCreateGrantRequest({ validForHours: 72, maxBytes: "007" }, "$"), /canonical decimal string/);
    expectDecodeError(() => decodeCreateGrantRequest({ validForHours: 72, maxBytes: "0" }, "$"), /must be positive/);
    expectDecodeError(() => decodeCreateGrantRequest({ validForHours: 72, maxBytes: "-5" }, "$"), /canonical decimal string/);
  });
  it("bounds validForHours", () => {
    expectDecodeError(() => decodeCreateGrantRequest({ validForHours: 0, maxBytes: "1" }, "$"), /below the minimum/);
    expectDecodeError(() => decodeCreateGrantRequest({ validForHours: 1.5, maxBytes: "1" }, "$"), /safe integer/);
    expectDecodeError(
      () => decodeCreateGrantRequest({ validForHours: 24 * 366 + 1, maxBytes: "1" }, "$"),
      /exceeds the maximum/,
    );
  });
  it("round-trips grant records and both mutation responses", () => {
    assert.deepEqual(roundTripJson(grant, encodeGrantRecord, decodeGrantRecord), grant);
    assert.deepEqual(roundTripJson(created, encodeCreateGrantResponse, decodeCreateGrantResponse), created);
    assert.deepEqual(roundTripJson(revoked, encodeRevokeGrantResponse, decodeRevokeGrantResponse), revoked);
  });
  it("rejects a grant mutation whose state does not match the mutation", () => {
    expectDecodeError(
      () => decodeCreateGrantResponse({ grant: { ...revoked.grant, maxBytes: "268435456" }, uploadPath: `/upload#grant=${secret}` }, "$"),
      /must be issued/,
    );
    expectDecodeError(() => decodeRevokeGrantResponse({ grant: { ...grant, maxBytes: "268435456" } }, "$"), /must be revoked/);
  });
  it("validates uploadPath is a relative one-time link", () => {
    assert.equal(decodeUploadPath(`/upload#grant=${secret}`, "$"), `/upload#grant=${secret}`);
    expectDecodeError(() => decodeUploadPath(`https://evil.example/upload#grant=${secret}`, "$"), /must be relative/);
    expectDecodeError(() => decodeUploadPath(`//evil.example/upload#grant=${secret}`, "$"), /protocol-relative/);
    expectDecodeError(() => decodeUploadPath(`/upload#grant=${secret}\\more`, "$"), /forward slashes/);
    expectDecodeError(() => decodeUploadPath("/upload", "$"), /#grant=/);
    expectDecodeError(() => decodeUploadPath(`/upload#grant=${secret.slice(0, 8)}`, "$"), /too short/);
  });
  it("keeps the secret in the fragment only (never a path segment)", () => {
    const json = toJsonText(encodeCreateGrantResponse(created));
    assert.match(json, /"uploadPath":"\/upload#grant=/);
    assert.ok(!/"uploadPath":"\/upload\/[A-Za-z0-9_-]+"/.test(json), "secret must not sit in the path");
  });
});

describe("dumps and retention (7.7)", () => {
  const dumpDetail: DumpDetailResponse = {
    dumpId: ID_DUMP,
    case: { caseId: ID_CASE, title: "Crash on 1.4.2" },
    phase: "available",
    originalName: "crash.dmp",
    byteSize: 1048576n,
    sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    validation: "valid",
    coverage: "full-memory-declared",
    downloadable: true,
    receivedAt: NOW,
    availableAt: LATER,
    purgeAt: null,
    purgedAt: null,
    inspectionError: null,
    symbolCoverage: [
      { name: "electron.exe", debugFile: DEBUG_FILE, debugId: DEBUG_ID, status: "present", artifactId: ID_SYMBOL_COVERAGE },
      { name: "gpu.dll", debugFile: "gpu.pdb", debugId: "4B5D6789012345678ABCDEF13A9C1F2E", status: "missing", artifactId: null },
      { name: "third_party.dll", debugFile: null, debugId: null, status: "unidentified", artifactId: null },
    ] satisfies readonly ModuleSymbolCoverage[],
    activity: [{ occurredAt: NOW, action: "DumpReceived" }],
  };
  const retentionRequest: RetentionRequest = { days: 30 };
  const retentionResponse: RetentionResponse = { dump: { dumpId: ID_DUMP, purgeAt: LATER } };

  it("round-trips the dump detail response including nullable facts", () => {
    assert.deepEqual(roundTripJson(dumpDetail, encodeDumpDetailResponse, decodeDumpDetailResponse), dumpDetail);
  });
  it("bounds module symbol coverage on dump detail", () => {
    const encoded = encodeDumpDetailResponse(dumpDetail);
    assert.deepEqual(encoded.symbolCoverage, [
      { name: "electron.exe", debugFile: DEBUG_FILE, debugId: DEBUG_ID, status: "present", artifactId: ID_SYMBOL_COVERAGE },
      { name: "gpu.dll", debugFile: "gpu.pdb", debugId: "4B5D6789012345678ABCDEF13A9C1F2E", status: "missing", artifactId: null },
      { name: "third_party.dll", debugFile: null, debugId: null, status: "unidentified", artifactId: null },
    ]);
    expectDecodeError(
      () => decodeDumpDetailResponse({
        ...encoded,
        symbolCoverage: [{ name: null, debugFile: null, debugId: null, status: "unknown", artifactId: null }],
      }, "$"),
      /module symbol status is invalid/,
    );
    expectDecodeError(
      () => decodeDumpDetailResponse({
        ...encoded,
        symbolCoverage: [{ name: "x".repeat(1025), debugFile: null, debugId: null, status: "unidentified", artifactId: null }],
      }, "$"),
      /name exceeds 1024 characters/,
    );
  });
  it("round-trips retention request and response", () => {
    assert.deepEqual(roundTripJson(retentionRequest, encodeRetentionRequest, decodeRetentionRequest), retentionRequest);
    assert.deepEqual(roundTripJson(retentionResponse, encodeRetentionResponse, decodeRetentionResponse), retentionResponse);
  });
  it("bounds retention days to a positive whole number", () => {
    expectDecodeError(() => decodeRetentionRequest({ days: 0 }, "$"), /below the minimum/);
    expectDecodeError(() => decodeRetentionRequest({ days: 36_501 }, "$"), /exceeds the maximum/);
    expectDecodeError(() => decodeRetentionRequest({ days: 2.5 }, "$"), /safe integer/);
  });
  it("rejects non-canonical hashes and non-UTC timestamps in dump facts", () => {
    expectDecodeError(() => decodeDumpDetailResponse({ ...dumpDetail, byteSize: "1048576", sha256: "ZZZ" }, "$"), /sha256 is malformed/);
    expectDecodeError(
      () => decodeDumpDetailResponse({ ...dumpDetail, byteSize: "1048576", purgeAt: "2026-01-15T10:30:00.123+08:00" }, "$"),
      /not a canonical UTC timestamp/,
    );
    expectDecodeError(() => decodeDumpDetailResponse({ ...dumpDetail, byteSize: "1048576", purgeAt: "2026-01-15T10:30:00Z" }, "$"), /not a canonical UTC timestamp/);
  });
});

describe("operations (7.7)", () => {
  const operations: OperationsResponse = {
    integrity: { status: "degraded", errorCount: 1, errors: ["vault mirror out of sync"] },
    uploads: { active: 1, capacity: 2 },
    postProcessing: { pending: 2, exhausted: 0, totalRetries: 3 },
    runtimeJobs: [{ name: "post-processing", running: true, runs: 12, failures: 1 }],
  };
  it("round-trips the operations response and health check", () => {
    assert.deepEqual(roundTripJson(operations, encodeOperationsResponse, decodeOperationsResponse), operations);
    assert.deepEqual(roundTripJson({ status: "ok" as const }, encodeHealthResponse, decodeHealthResponse), { status: "ok" });
  });
  it("rejects unknown integrity statuses and wrong-typed job fields", () => {
    expectDecodeError(() => decodeOperationsResponse({ ...operations, integrity: { ...operations.integrity, status: "warn" } }, "$"), /integrity status is invalid/);
    expectDecodeError(() => decodeOperationsResponse({ ...operations, runtimeJobs: [{ name: "x", running: true, runs: "a", failures: 0 }] }, "$"), /job runs must be a number/);
  });
});

describe("uploads (7.6)", () => {
  const complete: UploadCompleteResponse = {
    dumpId: ID_DUMP,
    phase: "available",
    byteSize: 1048576n,
    sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  };
  const queued: UploadQueuedResponse = {
    dumpId: ID_DUMP,
    byteSize: 1048576n,
    sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    processing: "retry-queued",
  };

  it("round-trips 201 and 202 success bodies", () => {
    assert.deepEqual(roundTripJson(complete, encodeUploadCompleteResponse, decodeUploadCompleteResponse), complete);
    assert.deepEqual(roundTripJson(queued, encodeUploadQueuedResponse, decodeUploadQueuedResponse), queued);
  });
  it("rejects wrong phase/processing vocabularies", () => {
    expectDecodeError(() => decodeUploadCompleteResponse({ ...complete, byteSize: "1048576", phase: "deleting" }, "$"), /upload phase is invalid/);
    expectDecodeError(() => decodeUploadQueuedResponse({ ...queued, byteSize: "1048576", processing: "sealed" }, "$"), /upload processing state is invalid/);
  });
  it("round-trips Unicode filenames through base64url UTF-8", () => {
    for (const name of ["crash.dmp", "崩溃报告 ☕.dmp", "minidump_2026-01-15_10-30.dmp", "español ñ.dmp"]) {
      const encoded = encodeFilenameBase64url(name);
      assert.match(encoded, /^[A-Za-z0-9_-]+$/);
      assert.equal(decodeFilenameBase64url(encoded), name);
    }
  });
  it("rejects unsafe, malformed, and non-UTF-8 filename headers", () => {
    expectDecodeError(() => decodeFilenameBase64url("not base64url!"), /not base64url/);
    expectDecodeError(() => decodeFilenameBase64url(encodeFilenameBase64url("a/b.dmp")), /unsafe characters/);
    expectDecodeError(() => decodeFilenameBase64url(encodeFilenameBase64url("")), /no bytes|unsafe|empty/);
    // Raw bytes 0xff 0xfe are not valid UTF-8.
    const invalidUtf8 = base64urlOf([0xff, 0xfe, 0x41]);
    expectDecodeError(() => decodeFilenameBase64url(invalidUtf8), /UTF-8|invalid/);
  });
  it("parses the share fragment and rejects absent grants", () => {
    const secret = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-";
    assert.equal(parseUploadFragment(`#grant=${secret}`), secret);
    assert.equal(parseUploadFragment("#grant="), null);
    assert.equal(parseUploadFragment(""), null);
    assert.equal(parseUploadFragment("#other=1"), null);
  });
  it("validates the upload grant bearer header", () => {
    const secret = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-";
    assert.equal(decodeUploadGrantSecret(secret), secret);
    expectDecodeError(() => decodeUploadGrantSecret("short"), /malformed/);
    expectDecodeError(() => decodeUploadGrantSecret("not+valid="), /malformed/);
  });
});

describe("duplicate and malformed JSON text", () => {
  it("rejects duplicate object keys before parsing", () => {
    const json = '{"authenticated":true,"csrfToken":"a","authenticated":false}';
    expectDecodeError(() => decodeJsonText(json, decodeSessionResponse), /duplicate field/);
  });
  it("rejects duplicates nested inside arrays", () => {
    const json = '{"cases":[{"caseId":"c","title":"t","status":"new","createdAt":"2026-01-15T10:30:00.123Z","caseId":"again"}]}';
    expectDecodeError(() => decodeJsonText(json, decodeSearchResponseFrom), /duplicate field/);
  });
  it("rejects malformed JSON with a content-free message", () => {
    expectDecodeError(() => decodeJsonText('{"authenticated":', decodeSessionResponse), /malformed/);
  });
  it("rejects oversized payloads", () => {
    const huge = '{"authenticated":' + " ".repeat(1_048_576) + "false}";
    expectDecodeError(() => decodeJsonText(huge, decodeSessionResponse), /size limit/);
  });
});

describe("symbols (symbols-design)", () => {
  const ID_SYMBOL = "symbol_01JTEST0000000000000000000";
  const DEBUG_ID = "3A9C8E1F9C9B4E4D8F0E1A2B3C4D5E601";
  const SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const CODE_FILE = "electron.exe";
  const CODE_ID = "5F3759DF20000";
  const identity = {
    artifactId: ID_SYMBOL,
    kind: "pdb" as const,
    debugFile: "electron.pdb",
    debugId: DEBUG_ID,
    codeFile: null,
    codeId: null,
    byteSize: 8_589_934_592n,
    sha256: SHA256,
  } as const;
  /** The EXE kind (milestone 3, decision D2 lifted): code identity, no debug identity. */
  const exeIdentity = {
    artifactId: ID_SYMBOL,
    kind: "exe" as const,
    debugFile: null,
    debugId: null,
    codeFile: CODE_FILE,
    codeId: CODE_ID,
    byteSize: 8_589_934_592n,
    sha256: SHA256,
  } as const;
  const bare: SymbolRecord = { ...identity, ingestedAt: NOW };
  const exeBare: SymbolRecord = { ...exeIdentity, ingestedAt: NOW };
  const annotated: SymbolRecord = { ...bare, product: "Electron", version: "41.10.6", arch: "x64" };

  it("round-trips the ingest response for new and deduplicated identities", () => {
    const fresh: SymbolIngestResponse = { ...identity, deduplicated: false };
    const dedup: SymbolIngestResponse = { ...identity, deduplicated: true };
    assert.deepEqual(roundTripJson(fresh, encodeSymbolIngestResponse, decodeSymbolIngestResponse), fresh);
    assert.deepEqual(roundTripJson(dedup, encodeSymbolIngestResponse, decodeSymbolIngestResponse), dedup);
    const json = toJsonText(encodeSymbolIngestResponse(fresh));
    assert.match(json, /"byteSize":"8589934592"/);
    assert.match(json, /"kind":"pdb"/);
    assert.match(json, /"codeFile":null/);
    assert.match(json, /"deduplicated":false/);
  });
  it("round-trips an EXE ingest response and record (code identity, no debug identity)", () => {
    const fresh: SymbolIngestResponse = { ...exeIdentity, deduplicated: false };
    assert.deepEqual(roundTripJson(fresh, encodeSymbolIngestResponse, decodeSymbolIngestResponse), fresh);
    const json = toJsonText(encodeSymbolIngestResponse(fresh));
    assert.match(json, /"kind":"exe"/);
    assert.match(json, /"debugFile":null/);
    assert.match(json, /"codeFile":"electron\.exe"/);
    assert.match(json, /"codeId":"5F3759DF20000"/);
    assert.deepEqual(roundTripJson(exeBare, encodeSymbolRecord, decodeSymbolRecord), exeBare);
  });
  it("tolerates identity keys absent from the wire (absent normalizes to null)", () => {
    const legacyPdb = {
      artifactId: ID_SYMBOL,
      debugFile: "electron.pdb",
      debugId: DEBUG_ID,
      kind: "pdb",
      byteSize: "1024",
      sha256: SHA256,
      ingestedAt: NOW,
    };
    const decoded = decodeSymbolRecord(legacyPdb, "$");
    assert.equal(decoded.codeFile, null);
    assert.equal(decoded.codeId, null);
    const legacyExe = { ...legacyPdb, debugFile: null, debugId: null, codeFile: CODE_FILE, codeId: CODE_ID, kind: "exe" };
    assert.equal(decodeSymbolRecord(legacyExe, "$").debugFile, null);
  });
  it("round-trips symbol records with annotations absent or present", () => {
    const decodedBare = roundTripJson(bare, encodeSymbolRecord, decodeSymbolRecord);
    assert.deepEqual(decodedBare, bare);
    assert.ok(!("product" in decodedBare));
    assert.ok(!("version" in decodedBare));
    assert.ok(!("arch" in decodedBare));
    const wire = encodeSymbolRecord(bare);
    assert.ok(!("product" in wire));
    assert.ok(!("arch" in wire));
    assert.deepEqual(roundTripJson(annotated, encodeSymbolRecord, decodeSymbolRecord), annotated);
  });
  it("round-trips the symbol list response", () => {
    const list: SymbolListResponse = { symbols: [annotated, bare, exeBare] };
    assert.deepEqual(roundTripJson(list, encodeSymbolListResponse, decodeSymbolListResponse), list);
    const empty: SymbolListResponse = { symbols: [] };
    assert.deepEqual(roundTripJson(empty, encodeSymbolListResponse, decodeSymbolListResponse), empty);
  });
  it("validates sha256 hex, byteSize decimals, kind, and deduplicated", () => {
    const wire = encodeSymbolIngestResponse({ ...identity, deduplicated: false });
    expectDecodeError(() => decodeSymbolIngestResponse({ ...wire, sha256: SHA256.toUpperCase() }, "$"), /sha256 is malformed/);
    expectDecodeError(() => decodeSymbolIngestResponse({ ...wire, sha256: SHA256.slice(0, 63) }, "$"), /sha256 is malformed/);
    expectDecodeError(() => decodeSymbolIngestResponse({ ...wire, sha256: 42 }, "$"), /sha256 must be a string/);
    expectDecodeError(() => decodeSymbolIngestResponse({ ...wire, byteSize: 8_589_934_592 }, "$"), /byteSize must be a string/);
    expectDecodeError(() => decodeSymbolIngestResponse({ ...wire, byteSize: "8589934592.0" }, "$"), /canonical decimal string/);
    expectDecodeError(() => decodeSymbolIngestResponse({ ...wire, byteSize: "007" }, "$"), /canonical decimal string/);
    // Both kinds decode (decision D2 lifted); an unknown kind does not, and
    // the identity pair the kind resolves by must be present.
    expectDecodeError(() => decodeSymbolIngestResponse({ ...wire, kind: "sym" }, "$"), /symbol kind is invalid/);
    expectDecodeError(() => decodeSymbolIngestResponse({ ...wire, kind: "exe" }, "$"), /an exe symbol must carry a code identity/);
    expectDecodeError(
      () => decodeSymbolIngestResponse({ ...encodeSymbolIngestResponse({ ...identity, deduplicated: false }), debugId: null }, "$"),
      /a pdb symbol must carry a debug identity/,
    );
    expectDecodeError(() => decodeSymbolIngestResponse({ ...wire, deduplicated: "no" }, "$"), /must be a boolean/);
    expectDecodeError(() => decodeSymbolIngestResponse({ ...wire, extra: 1 }, "$"), /unexpected field/);
    const missing: Record<string, unknown> = {
      artifactId: ID_SYMBOL,
      debugFile: "electron.pdb",
      debugId: DEBUG_ID,
      kind: "pdb",
      byteSize: "8589934592",
      sha256: SHA256,
    };
    expectDecodeError(() => decodeSymbolIngestResponse(missing, "$"), /missing required field/);
  });
  it("validates identifiers and annotations on records and lists", () => {
    const wire = encodeSymbolRecord(annotated);
    expectDecodeError(() => decodeSymbolRecord({ ...wire, debugId: "has space" }, "$"), /debugId is malformed/);
    expectDecodeError(() => decodeSymbolRecord({ ...wire, debugFile: "x".repeat(129) }, "$"), /debugFile exceeds 128 characters/);
    expectDecodeError(() => decodeSymbolRecord({ ...wire, artifactId: 7 }, "$"), /artifactId must be a string/);
    expectDecodeError(() => decodeSymbolRecord({ ...wire, product: "p".repeat(201) }, "$"), /product exceeds 200 characters/);
    expectDecodeError(() => decodeSymbolRecord({ ...wire, ingestedAt: "2026-01-15T10:30:00Z" }, "$"), /not a canonical UTC timestamp/);
    expectDecodeError(() => decodeSymbolListResponse({ symbols: "x" }, "$"), /symbols must be an array/);
    expectDecodeError(() => decodeSymbolListResponse({ symbols: [{ ...wire, sha256: "not-hex" }] }, "$"), /sha256 is malformed/);
    expectDecodeError(() => decodeSymbolListResponse({ symbols: [], extra: true }, "$"), /unexpected field/);
  });
  it("publishes the ingest surface constants and the purge path builder", () => {
    assert.equal(X_SYMBOL_FILENAME_HEADER, "x-symbol-filename-base64url");
    assert.equal(SYMBOLS_PATH, "/api/v1/symbols");
    assert.equal(symbolPathForArtifact(ID_SYMBOL), `/api/v1/symbols/${ID_SYMBOL}`);
    assert.deepEqual([...SYMBOL_KINDS], ["pdb", "exe"]);
    assert.equal(MAX_SYMBOL_BYTES, 8_589_934_592n);
    assert.equal(MAX_SYMBOL_FILENAME_LENGTH, 1024);
  });
  it("reuses the dump filename base64url helper for the symbol filename header", () => {
    assert.equal(decodeSymbolFilenameBase64url(encodeSymbolFilenameBase64url("electron-41.10.6.pdb")), "electron-41.10.6.pdb");
    assert.equal(decodeSymbolFilenameBase64url(encodeSymbolFilenameBase64url("符号-α.pdb")), "符号-α.pdb");
    expectDecodeError(() => decodeSymbolFilenameBase64url("not base64url!"), /not base64url/);
    expectDecodeError(
      () => decodeSymbolFilenameBase64url(encodeSymbolFilenameBase64url("nested/electron.pdb")),
      /unsafe characters/,
    );
  });
  it("registers the symbols error codes in HTTP_ERROR_CODES", () => {
    for (const code of ["symbol_identity_unreadable", "symbol_kind_unsupported", "symbol_too_large"]) {
      assert.ok((HTTP_ERROR_CODES as readonly string[]).includes(code), `${code} must be a stable HTTP error code`);
    }
  });
});

function decodeSearchResponseFrom(value: unknown): CaseSearchResponse {
  return decodeCaseSearchResponse(value, "$");
}

function base64urlOf(bytes: number[]): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const n = (a << 16) | (b << 8) | c;
    out += alphabet[(n >> 18) & 63]! + alphabet[(n >> 12) & 63]!;
    if (i + 1 < bytes.length) out += alphabet[(n >> 6) & 63];
    if (i + 2 < bytes.length) out += alphabet[n & 63];
  }
  return out;
}
