import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DecodeError,
  EXPORT_STATUSES,
  IMPORT_STATUSES,
  MAX_EXPORT_LIST_ITEMS,
  decodeCreateExportResponse,
  decodeCreateImportRequest,
  decodeCreateImportResponse,
  decodeDeleteExportResponse,
  decodeExportSummary,
  decodeImportProgressResponse,
  decodeJsonText,
  decodeListExportsResponse,
  encodeCreateExportResponse,
  encodeCreateImportRequest,
  encodeCreateImportResponse,
  encodeDeleteExportResponse,
  encodeExportSummary,
  encodeImportProgressResponse,
  encodeListExportsResponse,
  toJsonText,
  type CreateExportResponse,
  type CreateImportRequest,
  type CreateImportResponse,
  type Decoder,
  type DeleteExportResponse,
  type ExportSummary,
  type ImportProgressResponse,
  type ListExportsResponse,
} from "../src/index.js";

const ID_EXPORT = "export_01JTEST0000000000000000000";
const ID_IMPORT = "import_01JTEST0000000000000000000";

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

describe("transfer vocabularies", () => {
  it("exposes the exact export and import status vocabularies", () => {
    assert.deepEqual([...EXPORT_STATUSES], ["running", "sealed", "failed"]);
    assert.deepEqual([...IMPORT_STATUSES], ["running", "finished", "failed"]);
  });
});

describe("transfer exports", () => {
  const running: ExportSummary = {
    exportId: ID_EXPORT,
    status: "running",
    createdAt: NOW,
    byteSize: null,
    error: null,
  };
  const sealed: ExportSummary = { ...running, status: "sealed", byteSize: "73400320" };
  const failed: ExportSummary = { ...running, status: "failed", error: "vault read failed" };

  it("round-trips the create-export response", () => {
    const response: CreateExportResponse = { exportId: ID_EXPORT };
    assert.deepEqual(roundTripJson(response, encodeCreateExportResponse, decodeCreateExportResponse), response);
  });
  it("rejects malformed create-export responses", () => {
    expectDecodeError(() => decodeCreateExportResponse({}, "$"), /missing required field/);
    expectDecodeError(() => decodeCreateExportResponse({ exportId: 42 }, "$"), /must be a string/);
    expectDecodeError(() => decodeCreateExportResponse({ exportId: ID_EXPORT, extra: true }, "$"), /unexpected field/);
  });
  it("round-trips export summaries in every status", () => {
    for (const summary of [running, sealed, failed]) {
      assert.deepEqual(roundTripJson(summary, encodeExportSummary, decodeExportSummary), summary);
    }
  });
  it("keeps byteSize a canonical decimal string on the wire", () => {
    const encoded = encodeExportSummary(sealed);
    assert.equal(typeof encoded.byteSize, "string");
    assert.equal(encoded.byteSize, "73400320");
    expectDecodeError(() => decodeExportSummary({ ...sealed, byteSize: 73400320 }, "$"), /byteSize must be a string/);
    expectDecodeError(() => decodeExportSummary({ ...sealed, byteSize: "007" }, "$"), /byteSize is malformed/);
    expectDecodeError(() => decodeExportSummary({ ...sealed, byteSize: "73400320.0" }, "$"), /byteSize is malformed/);
    expectDecodeError(() => decodeExportSummary({ ...sealed, byteSize: "-5" }, "$"), /byteSize is malformed/);
  });
  it("rejects bad status, timestamp, error, and missing or extra fields", () => {
    expectDecodeError(() => decodeExportSummary({ ...sealed, status: "done" }, "$"), /export status is invalid/);
    expectDecodeError(
      () => decodeExportSummary({ ...sealed, createdAt: "2026-01-15T10:30:00+00:00" }, "$"),
      /not a canonical UTC timestamp/,
    );
    expectDecodeError(() => decodeExportSummary({ ...sealed, error: 42 }, "$"), /error must be a string/);
    expectDecodeError(
      () => decodeExportSummary({ ...failed, error: "x".repeat(2001) }, "$"),
      /error exceeds 2000 characters/,
    );
    expectDecodeError(() => decodeExportSummary({ status: "sealed", createdAt: NOW, byteSize: null, error: null }, "$"), /missing required field/);
    expectDecodeError(() => decodeExportSummary({ ...sealed, note: "x" }, "$"), /unexpected field/);
  });
  it("round-trips the bounded export list and enforces its bound", () => {
    const list: ListExportsResponse = { exports: [running, sealed, failed] };
    assert.deepEqual(roundTripJson(list, encodeListExportsResponse, decodeListExportsResponse), list);
    const tooMany = {
      exports: Array.from({ length: MAX_EXPORT_LIST_ITEMS + 1 }, (_, index) => ({
        ...sealed,
        exportId: `export_${index}`,
      })),
    };
    expectDecodeError(() => decodeListExportsResponse(tooMany, "$"), /exports exceeds 200 items/);
    expectDecodeError(() => decodeListExportsResponse({ exports: "none" }, "$"), /exports must be an array/);
  });
  it("round-trips the delete-export response and requires literal true", () => {
    const response: DeleteExportResponse = { deleted: true };
    assert.deepEqual(roundTripJson(response, encodeDeleteExportResponse, decodeDeleteExportResponse), response);
    expectDecodeError(() => decodeDeleteExportResponse({ deleted: false }, "$"), /deleted must be true/);
    expectDecodeError(() => decodeDeleteExportResponse({ deleted: "yes" }, "$"), /must be a boolean/);
    expectDecodeError(() => decodeDeleteExportResponse({}, "$"), /missing required field/);
  });
});

describe("transfer imports", () => {
  const request: CreateImportRequest = { path: "/var/lib/dump-ledger/exports/export_1/bundle.tar" };
  const running: ImportProgressResponse = {
    importId: ID_IMPORT,
    status: "running",
    verified: 3,
    imported: 3,
    rejected: 0,
    skipped: 1,
    error: null,
  };
  const finished: ImportProgressResponse = { ...running, status: "finished", verified: 11, imported: 10, rejected: 1, skipped: 2 };
  const failed: ImportProgressResponse = { ...running, status: "failed", error: "manifest schema mismatch" };

  it("round-trips the create-import request", () => {
    assert.deepEqual(roundTripJson(request, encodeCreateImportRequest, decodeCreateImportRequest), request);
  });
  it("rejects malformed create-import requests", () => {
    expectDecodeError(() => decodeCreateImportRequest({}, "$"), /missing required field/);
    expectDecodeError(() => decodeCreateImportRequest({ path: "" }, "$"), /path must not be empty/);
    expectDecodeError(() => decodeCreateImportRequest({ path: 42 }, "$"), /path must be a string/);
    expectDecodeError(() => decodeCreateImportRequest({ path: "x".repeat(1025) }, "$"), /path exceeds 1024 characters/);
    expectDecodeError(() => decodeCreateImportRequest({ path: "bad\npath" }, "$"), /contains control characters/);
    expectDecodeError(() => decodeCreateImportRequest({ path: request.path, extra: 1 }, "$"), /unexpected field/);
  });
  it("round-trips the create-import response", () => {
    const response: CreateImportResponse = { importId: ID_IMPORT };
    assert.deepEqual(roundTripJson(response, encodeCreateImportResponse, decodeCreateImportResponse), response);
    expectDecodeError(() => decodeCreateImportResponse({}, "$"), /missing required field/);
    expectDecodeError(() => decodeCreateImportResponse({ importId: null }, "$"), /must be a string/);
  });
  it("round-trips import progress in every status", () => {
    for (const progress of [running, finished, failed]) {
      assert.deepEqual(roundTripJson(progress, encodeImportProgressResponse, decodeImportProgressResponse), progress);
    }
  });
  it("rejects a bad status and negative, fractional, or wrong-typed counters", () => {
    expectDecodeError(() => decodeImportProgressResponse({ ...running, status: "done" }, "$"), /import status is invalid/);
    expectDecodeError(() => decodeImportProgressResponse({ ...running, verified: -1 }, "$"), /verified is below the minimum/);
    expectDecodeError(() => decodeImportProgressResponse({ ...running, imported: 1.5 }, "$"), /imported must be a safe integer/);
    expectDecodeError(() => decodeImportProgressResponse({ ...running, skipped: "2" }, "$"), /skipped must be a number/);
  });
  it("rejects missing, extra, and wrong-typed progress fields", () => {
    const { skipped: _dropped, ...missingSkipped } = running;
    expectDecodeError(() => decodeImportProgressResponse(missingSkipped, "$"), /missing required field/);
    expectDecodeError(() => decodeImportProgressResponse({ ...running, extra: true }, "$"), /unexpected field/);
    expectDecodeError(() => decodeImportProgressResponse({ ...failed, error: 42 }, "$"), /error must be a string/);
    expectDecodeError(
      () => decodeImportProgressResponse({ ...failed, error: "x".repeat(2001) }, "$"),
      /error exceeds 2000 characters/,
    );
  });
});
