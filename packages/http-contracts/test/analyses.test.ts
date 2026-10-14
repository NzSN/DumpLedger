import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DecodeError,
  MAX_ANALYSES_PER_DUMP,
  MAX_ANALYSIS_FACTS_BYTES,
  MAX_ANALYSIS_KIND_LENGTH,
  MAX_ANALYSIS_NAME_LENGTH,
  MAX_ANALYSIS_SUMMARY_LENGTH,
  MAX_ANALYSIS_VERSION_LENGTH,
  decodeAnalysisListResponse,
  decodeAnalysisReport,
  decodeJsonText,
  decodeRecordAnalysisRequest,
  encodeAnalysisListResponse,
  encodeAnalysisReport,
  encodeRecordAnalysisRequest,
  toJsonText,
  type AnalysisListResponse,
  type AnalysisReport,
  type Decoder,
  type RecordAnalysisRequest,
} from "../src/index.js";

const ID_ANALYSIS = "analysis_01JTEST0000000000000000000";
const ID_DUMP = "dump_01JTEST0000000000000000000";
const ID_DUPLICATE = "dump_01JTEST0000000000000000001";
const SHA256 = "0123456789abcdef".repeat(4);
const NOW = "2026-01-15T10:30:00.123Z";

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

/** A facts object whose compact serialization is exactly `bytes` ASCII characters. */
function factsOfSerializedSize(bytes: number): Record<string, unknown> {
  const empty = toJsonText({ note: "" });
  const facts = { note: "x".repeat(bytes - empty.length) };
  assert.equal(toJsonText(facts).length, bytes);
  return facts;
}

const fullRequest: RecordAnalysisRequest = {
  analyzer: { name: "triage-runner", version: "1.4.2" },
  kind: "triage",
  inputSha256: SHA256,
  outcome: "completed",
  summary: "Access violation in the renderer; stack matches a known pattern.",
  facts: { exceptionCode: 3_221_225_477, tags: ["renderer", "oob"], nested: { ok: true, count: 3, note: null } },
  duplicateOf: ID_DUPLICATE,
};

const minimalRequest: RecordAnalysisRequest = {
  analyzer: { name: "a", version: "0" },
  kind: "triage",
  inputSha256: SHA256,
  outcome: "failed",
  summary: "",
};

const fullReport: AnalysisReport = {
  analysisId: ID_ANALYSIS,
  dumpId: ID_DUMP,
  ...fullRequest,
  createdAt: NOW,
};

const minimalReport: AnalysisReport = {
  analysisId: ID_ANALYSIS,
  dumpId: ID_DUMP,
  ...minimalRequest,
  createdAt: NOW,
};

describe("record analysis requests", () => {
  it("round-trips a fully populated request", () => {
    assert.deepEqual(roundTripJson(fullRequest, encodeRecordAnalysisRequest, decodeRecordAnalysisRequest), fullRequest);
  });

  it("round-trips a minimal request without facts and duplicateOf", () => {
    assert.deepEqual(roundTripJson(minimalRequest, encodeRecordAnalysisRequest, decodeRecordAnalysisRequest), minimalRequest);
    const encoded = encodeRecordAnalysisRequest(minimalRequest);
    assert.ok(!("facts" in encoded));
    assert.ok(!("duplicateOf" in encoded));
  });

  it("keeps an explicit null duplicateOf when present", () => {
    const nulled: RecordAnalysisRequest = { ...minimalRequest, duplicateOf: null };
    const decoded = roundTripJson(nulled, encodeRecordAnalysisRequest, decodeRecordAnalysisRequest);
    assert.deepEqual(decoded, nulled);
    assert.ok("duplicateOf" in decoded);
    assert.equal(decoded.duplicateOf, null);
  });

  it("rejects missing, unknown, and wrong-typed fields", () => {
    const encoded = encodeRecordAnalysisRequest(minimalRequest);
    expectDecodeError(() => decodeRecordAnalysisRequest({}, "$"), /missing required field/);
    expectDecodeError(() => decodeRecordAnalysisRequest([], "$"), /record analysis request must be a JSON object/);
    expectDecodeError(() => decodeRecordAnalysisRequest({ ...encoded, extra: true }, "$"), /unexpected field/);
    expectDecodeError(() => decodeRecordAnalysisRequest({ ...encoded, kind: 7 }, "$"), /kind must be a string/);
    expectDecodeError(() => decodeRecordAnalysisRequest({ ...encoded, summary: null }, "$"), /summary must be a string/);
    expectDecodeError(
      () => decodeRecordAnalysisRequest({ ...encoded, inputSha256: SHA256.toUpperCase() }, "$"),
      /inputSha256 is malformed/,
    );
    expectDecodeError(
      () => decodeRecordAnalysisRequest({ ...encoded, inputSha256: SHA256.slice(0, 63) }, "$"),
      /inputSha256 is malformed/,
    );
    expectDecodeError(
      () => decodeRecordAnalysisRequest({ ...encoded, inputSha256: `${SHA256}0` }, "$"),
      /inputSha256 exceeds 64 characters/,
    );
    expectDecodeError(
      () => decodeRecordAnalysisRequest({ ...encoded, inputSha256: "z".repeat(64) }, "$"),
      /inputSha256 is malformed/,
    );
    expectDecodeError(() => decodeRecordAnalysisRequest({ ...encoded, outcome: "skipped" }, "$"), /outcome is invalid/);
    expectDecodeError(() => decodeRecordAnalysisRequest({ ...encoded, outcome: null }, "$"), /outcome is invalid/);
    expectDecodeError(() => decodeRecordAnalysisRequest({ ...encoded, analyzer: null }, "$"), /analyzer must be a JSON object/);
    expectDecodeError(() => decodeRecordAnalysisRequest({ ...encoded, analyzer: [] }, "$"), /analyzer must be a JSON object/);
  });

  it("rejects unknown, missing, and wrong-typed analyzer fields", () => {
    const encoded = encodeRecordAnalysisRequest(minimalRequest);
    expectDecodeError(
      () => decodeRecordAnalysisRequest({ ...encoded, analyzer: { name: "a" } }, "$"),
      /missing required field/,
    );
    expectDecodeError(
      () => decodeRecordAnalysisRequest({ ...encoded, analyzer: { name: "a", version: "0", extra: true } }, "$"),
      /unexpected field/,
    );
    expectDecodeError(
      () => decodeRecordAnalysisRequest({ ...encoded, analyzer: { name: 1, version: "0" } }, "$"),
      /analyzer.name must be a string/,
    );
  });

  it("bounds the analyzer name and version", () => {
    const encoded = encodeRecordAnalysisRequest(minimalRequest);
    expectDecodeError(
      () => decodeRecordAnalysisRequest({ ...encoded, analyzer: { name: "", version: "0" } }, "$"),
      /analyzer.name must not be empty/,
    );
    expectDecodeError(
      () => decodeRecordAnalysisRequest({ ...encoded, analyzer: { name: "n".repeat(129), version: "0" } }, "$"),
      /analyzer.name exceeds 128 characters/,
    );
    expectDecodeError(
      () => decodeRecordAnalysisRequest({ ...encoded, analyzer: { name: "a", version: "" } }, "$"),
      /analyzer.version must not be empty/,
    );
    expectDecodeError(
      () => decodeRecordAnalysisRequest({ ...encoded, analyzer: { name: "a", version: "v".repeat(65) } }, "$"),
      /analyzer.version exceeds 64 characters/,
    );
    const maximum = decodeRecordAnalysisRequest(
      { ...encoded, analyzer: { name: "n".repeat(128), version: "v".repeat(64) } },
      "$",
    );
    assert.equal(maximum.analyzer.name.length, 128);
    assert.equal(maximum.analyzer.version.length, 64);
  });

  it("bounds the kind at 64 characters", () => {
    const encoded = encodeRecordAnalysisRequest(minimalRequest);
    expectDecodeError(() => decodeRecordAnalysisRequest({ ...encoded, kind: "" }, "$"), /kind must not be empty/);
    expectDecodeError(
      () => decodeRecordAnalysisRequest({ ...encoded, kind: "k".repeat(65) }, "$"),
      /kind exceeds 64 characters/,
    );
    assert.equal(decodeRecordAnalysisRequest({ ...encoded, kind: "k".repeat(64) }, "$").kind.length, 64);
  });

  it("accepts an empty summary and bounds it at 2000 characters", () => {
    const encoded = encodeRecordAnalysisRequest(minimalRequest);
    assert.equal(decodeRecordAnalysisRequest({ ...encoded, summary: "" }, "$").summary, "");
    assert.equal(decodeRecordAnalysisRequest({ ...encoded, summary: "s".repeat(2000) }, "$").summary.length, 2000);
    expectDecodeError(
      () => decodeRecordAnalysisRequest({ ...encoded, summary: "s".repeat(2001) }, "$"),
      /summary exceeds 2000 characters/,
    );
  });

  it("requires facts to be a JSON object and rejects non-JSON values", () => {
    const encoded = encodeRecordAnalysisRequest(minimalRequest);
    expectDecodeError(() => decodeRecordAnalysisRequest({ ...encoded, facts: null }, "$"), /facts must be a JSON object/);
    expectDecodeError(() => decodeRecordAnalysisRequest({ ...encoded, facts: [1, 2] }, "$"), /facts must be a JSON object/);
    expectDecodeError(() => decodeRecordAnalysisRequest({ ...encoded, facts: "text" }, "$"), /facts must be a JSON object/);
    expectDecodeError(
      () => decodeRecordAnalysisRequest({ ...encoded, facts: { bad: undefined } }, "$"),
      /facts must contain only JSON values/,
    );
    expectDecodeError(
      () => decodeRecordAnalysisRequest({ ...encoded, facts: { bad: 1n } }, "$"),
      /facts must contain only JSON values/,
    );
    expectDecodeError(
      () => decodeRecordAnalysisRequest({ ...encoded, facts: { bad: Number.NaN } }, "$"),
      /facts must contain only finite JSON numbers/,
    );
    expectDecodeError(
      () => decodeRecordAnalysisRequest({ ...encoded, facts: { bad: Number.POSITIVE_INFINITY } }, "$"),
      /facts must contain only finite JSON numbers/,
    );
    expectDecodeError(
      () => decodeRecordAnalysisRequest({ ...encoded, facts: { bad: (): number => 1 } }, "$"),
      /facts must contain only JSON values/,
    );
  });

  it("bounds facts at 4096 bytes of serialized JSON", () => {
    assert.equal(MAX_ANALYSIS_FACTS_BYTES, 4096);
    const encoded = encodeRecordAnalysisRequest(minimalRequest);
    const fits = factsOfSerializedSize(MAX_ANALYSIS_FACTS_BYTES);
    assert.deepEqual(decodeRecordAnalysisRequest({ ...encoded, facts: fits }, "$").facts, fits);
    const overflows = factsOfSerializedSize(MAX_ANALYSIS_FACTS_BYTES + 1);
    expectDecodeError(
      () => decodeRecordAnalysisRequest({ ...encoded, facts: overflows }, "$"),
      /facts exceeds 4096 serialized bytes/,
    );
  });

  it("measures the facts bound in UTF-8 bytes rather than characters", () => {
    const encoded = encodeRecordAnalysisRequest(minimalRequest);
    const heavy = { note: "é".repeat(2043) };
    assert.ok(toJsonText(heavy).length < MAX_ANALYSIS_FACTS_BYTES);
    assert.ok(Buffer.byteLength(toJsonText(heavy), "utf8") > MAX_ANALYSIS_FACTS_BYTES);
    expectDecodeError(
      () => decodeRecordAnalysisRequest({ ...encoded, facts: heavy }, "$"),
      /facts exceeds 4096 serialized bytes/,
    );
    const fits = { note: "é".repeat(2042) };
    assert.equal(Buffer.byteLength(toJsonText(fits), "utf8"), MAX_ANALYSIS_FACTS_BYTES - 1);
    assert.deepEqual(decodeRecordAnalysisRequest({ ...encoded, facts: fits }, "$").facts, fits);
  });

  it("validates duplicateOf as a dumpId-shaped identifier or null", () => {
    const encoded = encodeRecordAnalysisRequest(minimalRequest);
    expectDecodeError(
      () => decodeRecordAnalysisRequest({ ...encoded, duplicateOf: "" }, "$"),
      /duplicateOf must not be empty/,
    );
    expectDecodeError(
      () => decodeRecordAnalysisRequest({ ...encoded, duplicateOf: "two words" }, "$"),
      /duplicateOf is malformed/,
    );
    expectDecodeError(
      () => decodeRecordAnalysisRequest({ ...encoded, duplicateOf: 7 }, "$"),
      /duplicateOf must be a string/,
    );
    assert.equal(decodeRecordAnalysisRequest({ ...encoded, duplicateOf: null }, "$").duplicateOf, null);
    assert.equal(decodeRecordAnalysisRequest({ ...encoded, duplicateOf: ID_DUPLICATE }, "$").duplicateOf, ID_DUPLICATE);
  });

  it("rejects duplicate JSON keys before parsing", () => {
    const duplicateTop = `{"analyzer":{"name":"a","version":"0"},"kind":"k","kind":"t","inputSha256":"${SHA256}","outcome":"completed","summary":""}`;
    expectDecodeError(() => decodeJsonText(duplicateTop, decodeRecordAnalysisRequest), /duplicate field/);
    const duplicateNested = `{"analyzer":{"name":"a","name":"b","version":"0"},"kind":"k","inputSha256":"${SHA256}","outcome":"completed","summary":""}`;
    expectDecodeError(() => decodeJsonText(duplicateNested, decodeRecordAnalysisRequest), /duplicate field/);
  });

  it("pins the exported bounds", () => {
    assert.equal(MAX_ANALYSES_PER_DUMP, 64);
    assert.equal(MAX_ANALYSIS_NAME_LENGTH, 128);
    assert.equal(MAX_ANALYSIS_VERSION_LENGTH, 64);
    assert.equal(MAX_ANALYSIS_KIND_LENGTH, 64);
    assert.equal(MAX_ANALYSIS_SUMMARY_LENGTH, 2000);
  });
});

describe("analysis reports", () => {
  it("round-trips a fully populated report", () => {
    assert.deepEqual(roundTripJson(fullReport, encodeAnalysisReport, decodeAnalysisReport), fullReport);
  });

  it("round-trips a minimal report and an explicit null duplicateOf", () => {
    assert.deepEqual(roundTripJson(minimalReport, encodeAnalysisReport, decodeAnalysisReport), minimalReport);
    const nulled: AnalysisReport = { ...minimalReport, duplicateOf: null };
    assert.deepEqual(roundTripJson(nulled, encodeAnalysisReport, decodeAnalysisReport), nulled);
  });

  it("encodes exactly the request fields plus identity", () => {
    assert.deepEqual(Object.keys(encodeAnalysisReport(minimalReport)).sort(), [
      "analysisId",
      "analyzer",
      "createdAt",
      "dumpId",
      "inputSha256",
      "kind",
      "outcome",
      "summary",
    ]);
  });

  it("rejects missing identity fields, unknown fields, and a non-canonical createdAt", () => {
    const encoded = encodeAnalysisReport(minimalReport);
    expectDecodeError(() => decodeAnalysisReport({}, "$"), /missing required field/);
    expectDecodeError(() => decodeAnalysisReport({ ...encoded, extra: true }, "$"), /unexpected field/);
    expectDecodeError(() => decodeAnalysisReport({ ...encoded, createdAt: "now" }, "$"), /createdAt is not a canonical UTC timestamp/);
    expectDecodeError(
      () => decodeAnalysisReport({ ...encoded, createdAt: "2026-01-15T10:30:00Z" }, "$"),
      /createdAt is not a canonical UTC timestamp/,
    );
    expectDecodeError(() => decodeAnalysisReport({ ...encoded, analysisId: "" }, "$"), /analysisId must not be empty/);
    expectDecodeError(() => decodeAnalysisReport({ ...encoded, analysisId: "two words" }, "$"), /analysisId is malformed/);
    expectDecodeError(() => decodeAnalysisReport({ ...encoded, dumpId: "two words" }, "$"), /dumpId is malformed/);
  });
});

describe("analysis list responses", () => {
  it("round-trips a populated page", () => {
    const response: AnalysisListResponse = { analyses: [fullReport, minimalReport] };
    assert.deepEqual(roundTripJson(response, encodeAnalysisListResponse, decodeAnalysisListResponse), response);
  });

  it("round-trips an empty page", () => {
    const response: AnalysisListResponse = { analyses: [] };
    assert.deepEqual(roundTripJson(response, encodeAnalysisListResponse, decodeAnalysisListResponse), response);
  });

  it("rejects unknown, missing, and wrong-typed page fields", () => {
    expectDecodeError(() => decodeAnalysisListResponse({}, "$"), /missing required field/);
    expectDecodeError(() => decodeAnalysisListResponse({ analyses: "none" }, "$"), /analyses must be an array/);
    expectDecodeError(
      () => decodeAnalysisListResponse({ analyses: [], extra: true }, "$"),
      /unexpected field/,
    );
    expectDecodeError(() => decodeAnalysisListResponse({ analyses: [{}] }, "$"), /missing required field/);
  });

  it("bounds the analyses array at 4096 items", () => {
    const encoder = (): Record<string, unknown> => encodeAnalysisReport(minimalReport);
    const tooMany = { analyses: Array.from({ length: 4097 }, encoder) };
    expectDecodeError(() => decodeAnalysisListResponse(tooMany, "$"), /analyses exceeds 4096 items/);
    const maximum = { analyses: Array.from({ length: 4096 }, encoder) };
    assert.equal(decodeAnalysisListResponse(maximum, "$").analyses.length, 4096);
  });
});
