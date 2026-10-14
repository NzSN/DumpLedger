import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DUMP_PHASES,
  DecodeError,
  MAX_CATALOG_ARCHITECTURE_LENGTH,
  MAX_CATALOG_CURSOR_LENGTH,
  MAX_CATALOG_PAGE,
  VALIDATION_STATES,
  decodeDumpCatalogEntry,
  decodeDumpCatalogParams,
  decodeDumpCatalogResponse,
  decodeJsonText,
  encodeDumpCatalogEntry,
  encodeDumpCatalogResponse,
  toJsonText,
  type Decoder,
  type DumpCatalogEntry,
  type DumpCatalogParams,
  type DumpCatalogResponse,
} from "../src/index.js";

const ID_DUMP = "dump_01JTEST0000000000000000000";
const ID_CASE = "case_01JTEST0000000000000000000";
const ID_CUSTOMER = "customer_01JTEST0000000000000000000";
const SHA256 = "0123456789abcdef".repeat(4);
const NOW = "2026-01-15T10:30:00.123Z";
const AVAILABLE = "2026-01-15T10:31:00.123Z";
const PURGE = "2026-02-14T10:30:00.123Z";

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

const fullEntry: DumpCatalogEntry = {
  dumpId: ID_DUMP,
  caseId: ID_CASE,
  customerId: ID_CUSTOMER,
  phase: "available",
  validation: "valid",
  originalName: "crash.dmp",
  byteSize: 73_400_320n,
  sha256: SHA256,
  receivedAt: NOW,
  availableAt: AVAILABLE,
  purgeAt: PURGE,
  architecture: "x64",
  exceptionCode: 3_221_225_477,
  exceptionAddress: 140_698_920_429_645n,
  symbolCoverage: { present: 12, missing: 3, unidentified: 1 },
};

const minimalEntry: DumpCatalogEntry = {
  dumpId: "dump_01JTEST0000000000000000001",
  caseId: ID_CASE,
  customerId: ID_CUSTOMER,
  phase: "receiving",
  validation: "not-checked",
  originalName: "pending.dmp",
  byteSize: null,
  sha256: null,
  receivedAt: NOW,
  availableAt: null,
  purgeAt: null,
  symbolCoverage: { present: 0, missing: 0, unidentified: 0 },
};

describe("dump catalog params", () => {
  it("accepts an empty query bag", () => {
    assert.deepEqual(decodeDumpCatalogParams({}), {});
  });

  it("accepts every filter with valid values", () => {
    const bag: Record<string, string | readonly string[] | undefined> = {
      caseId: ID_CASE,
      customerId: ID_CUSTOMER,
      phase: "available",
      validation: "valid",
      receivedAfter: NOW,
      receivedBefore: AVAILABLE,
      architecture: "x".repeat(MAX_CATALOG_ARCHITECTURE_LENGTH),
      exceptionCode: "3221225477",
      sha256: SHA256,
      cursor: "c".repeat(MAX_CATALOG_CURSOR_LENGTH),
    };
    const expected: DumpCatalogParams = {
      caseId: ID_CASE,
      customerId: ID_CUSTOMER,
      phase: "available",
      validation: "valid",
      receivedAfter: NOW,
      receivedBefore: AVAILABLE,
      architecture: "x".repeat(MAX_CATALOG_ARCHITECTURE_LENGTH),
      exceptionCode: 3_221_225_477,
      sha256: SHA256,
      cursor: "c".repeat(MAX_CATALOG_CURSOR_LENGTH),
    };
    assert.deepEqual(decodeDumpCatalogParams(bag), expected);
  });

  it("accepts every phase and validation vocabulary value", () => {
    for (const phase of DUMP_PHASES) {
      assert.deepEqual(decodeDumpCatalogParams({ phase }), { phase });
    }
    for (const validation of VALIDATION_STATES) {
      assert.deepEqual(decodeDumpCatalogParams({ validation }), { validation });
    }
  });

  it("decodes exceptionCode with unsigned 32-bit boundaries", () => {
    assert.deepEqual(decodeDumpCatalogParams({ exceptionCode: "0" }), { exceptionCode: 0 });
    assert.deepEqual(decodeDumpCatalogParams({ exceptionCode: "4294967295" }), {
      exceptionCode: 4_294_967_295,
    });
  });

  it("treats undefined-valued known parameters as absent", () => {
    assert.deepEqual(decodeDumpCatalogParams({ caseId: undefined, cursor: undefined }), {});
  });

  it("rejects duplicated parameters", () => {
    for (const key of [
      "caseId",
      "customerId",
      "phase",
      "validation",
      "receivedAfter",
      "receivedBefore",
      "architecture",
      "exceptionCode",
      "sha256",
      "cursor",
    ]) {
      const duplicates: Record<string, string | readonly string[] | undefined> = { [key]: ["a", "b"] };
      expectDecodeError(() => decodeDumpCatalogParams(duplicates), /must appear at most once/);
    }
  });

  it("rejects unknown parameters", () => {
    expectDecodeError(() => decodeDumpCatalogParams({ limit: "50" }), /unexpected query parameter/);
    expectDecodeError(() => decodeDumpCatalogParams({ Phase: "available" }), /unexpected query parameter/);
    expectDecodeError(
      () => decodeDumpCatalogParams({ phase: "available", unknown: undefined }),
      /unexpected query parameter/,
    );
  });

  it("rejects malformed identifiers and vocabulary values", () => {
    expectDecodeError(() => decodeDumpCatalogParams({ caseId: "" }), /caseId must not be empty/);
    expectDecodeError(() => decodeDumpCatalogParams({ caseId: "two words" }), /caseId is malformed/);
    expectDecodeError(() => decodeDumpCatalogParams({ customerId: "two words" }), /customerId is malformed/);
    expectDecodeError(() => decodeDumpCatalogParams({ phase: "purged" }), /dump phase is invalid/);
    expectDecodeError(() => decodeDumpCatalogParams({ validation: "validated" }), /validation state is invalid/);
  });

  it("rejects non-canonical received bounds", () => {
    expectDecodeError(
      () => decodeDumpCatalogParams({ receivedAfter: "2026-01-15T10:30:00+00:00" }),
      /receivedAfter is not a canonical UTC timestamp/,
    );
    expectDecodeError(
      () => decodeDumpCatalogParams({ receivedBefore: "2026-01-15" }),
      /receivedBefore is not a canonical UTC timestamp/,
    );
    expectDecodeError(
      () => decodeDumpCatalogParams({ receivedAfter: "2026-01-15T10:30:00Z" }),
      /receivedAfter is not a canonical UTC timestamp/,
    );
  });

  it("bounds architecture, cursor, and sha256", () => {
    expectDecodeError(
      () => decodeDumpCatalogParams({ architecture: "x".repeat(MAX_CATALOG_ARCHITECTURE_LENGTH + 1) }),
      /architecture exceeds 64 characters/,
    );
    expectDecodeError(() => decodeDumpCatalogParams({ architecture: "" }), /architecture must not be empty/);
    expectDecodeError(
      () => decodeDumpCatalogParams({ cursor: "c".repeat(MAX_CATALOG_CURSOR_LENGTH + 1) }),
      /cursor exceeds 256 characters/,
    );
    expectDecodeError(() => decodeDumpCatalogParams({ cursor: "has space" }), /cursor is malformed/);
    expectDecodeError(() => decodeDumpCatalogParams({ cursor: "" }), /cursor must not be empty/);
    expectDecodeError(
      () => decodeDumpCatalogParams({ sha256: SHA256.toUpperCase() }),
      /sha256 is malformed/,
    );
    expectDecodeError(() => decodeDumpCatalogParams({ sha256: "a".repeat(63) }), /sha256 is malformed/);
    expectDecodeError(
      () => decodeDumpCatalogParams({ sha256: "a".repeat(65) }),
      /sha256 exceeds 64 characters/,
    );
  });

  it("rejects non-uint32 exception codes", () => {
    expectDecodeError(
      () => decodeDumpCatalogParams({ exceptionCode: "4294967296" }),
      /exceptionCode exceeds the unsigned 32-bit range/,
    );
    expectDecodeError(
      () => decodeDumpCatalogParams({ exceptionCode: "99999999999" }),
      /exceptionCode exceeds 10 characters/,
    );
    expectDecodeError(() => decodeDumpCatalogParams({ exceptionCode: "-1" }), /exceptionCode is malformed/);
    expectDecodeError(() => decodeDumpCatalogParams({ exceptionCode: "007" }), /exceptionCode is malformed/);
    expectDecodeError(() => decodeDumpCatalogParams({ exceptionCode: "1.5" }), /exceptionCode is malformed/);
    expectDecodeError(() => decodeDumpCatalogParams({ exceptionCode: " " }), /exceptionCode is malformed/);
  });
});

describe("dump catalog entries", () => {
  it("round-trips a fully populated entry", () => {
    assert.deepEqual(roundTripJson(fullEntry, encodeDumpCatalogEntry, decodeDumpCatalogEntry), fullEntry);
  });

  it("keeps decimal strings on the wire for byte sizes and addresses", () => {
    const encoded = encodeDumpCatalogEntry(fullEntry);
    assert.equal(encoded.byteSize, "73400320");
    assert.equal(encoded.exceptionAddress, "140698920429645");
    assert.equal(encoded.exceptionCode, 3_221_225_477);
    expectDecodeError(
      () => decodeDumpCatalogEntry({ ...encoded, exceptionAddress: 140_698_920_429_645 }, "$"),
      /exceptionAddress must be a string/,
    );
  });

  it("round-trips a minimal entry", () => {
    assert.deepEqual(roundTripJson(minimalEntry, encodeDumpCatalogEntry, decodeDumpCatalogEntry), minimalEntry);
  });

  it("omits absent optional inspector facts when encoded", () => {
    const encoded = encodeDumpCatalogEntry(minimalEntry);
    assert.ok(!("architecture" in encoded));
    assert.ok(!("exceptionCode" in encoded));
    assert.ok(!("exceptionAddress" in encoded));
    const decoded = decodeDumpCatalogEntry(encoded, "$");
    assert.ok(!("architecture" in decoded));
    assert.ok(!("exceptionCode" in decoded));
    assert.ok(!("exceptionAddress" in decoded));
  });

  it("rejects unknown, missing, and wrong-typed fields", () => {
    const encoded = encodeDumpCatalogEntry(minimalEntry);
    expectDecodeError(() => decodeDumpCatalogEntry({}, "$"), /missing required field/);
    expectDecodeError(() => decodeDumpCatalogEntry({ ...encoded, extra: true }, "$"), /unexpected field/);
    expectDecodeError(() => decodeDumpCatalogEntry({ ...encoded, phase: "purged" }, "$"), /dump phase is invalid/);
    expectDecodeError(
      () => decodeDumpCatalogEntry({ ...encoded, validation: "unknown" }, "$"),
      /validation state is invalid/,
    );
    expectDecodeError(() => decodeDumpCatalogEntry({ ...encoded, byteSize: 73_400_320 }, "$"), /byteSize must be a string/);
    expectDecodeError(
      () => decodeDumpCatalogEntry({ ...encoded, byteSize: "007" }, "$"),
      /byteSize must be a canonical decimal string/,
    );
    expectDecodeError(
      () => decodeDumpCatalogEntry({ ...encoded, byteSize: "-5" }, "$"),
      /byteSize must be a canonical decimal string/,
    );
    expectDecodeError(
      () => decodeDumpCatalogEntry({ ...encoded, sha256: SHA256.toUpperCase() }, "$"),
      /sha256 is malformed/,
    );
    expectDecodeError(
      () => decodeDumpCatalogEntry({ ...encoded, sha256: "a".repeat(63) }, "$"),
      /sha256 is malformed/,
    );
    expectDecodeError(
      () => decodeDumpCatalogEntry({ ...encoded, sha256: "a".repeat(65) }, "$"),
      /sha256 exceeds 64 characters/,
    );
    expectDecodeError(
      () => decodeDumpCatalogEntry({ ...encoded, receivedAt: "now" }, "$"),
      /receivedAt is not a canonical UTC timestamp/,
    );
    expectDecodeError(
      () => decodeDumpCatalogEntry({ ...encoded, availableAt: "2026-01-15T10:31:00Z" }, "$"),
      /availableAt is not a canonical UTC timestamp/,
    );
    expectDecodeError(() => decodeDumpCatalogEntry({ ...encoded, purgeAt: 42 }, "$"), /purgeAt must be a string/);
  });

  it("bounds inspector facts and coverage counts", () => {
    const encoded = encodeDumpCatalogEntry(minimalEntry);
    expectDecodeError(
      () => decodeDumpCatalogEntry({ ...encoded, architecture: "x".repeat(65) }, "$"),
      /architecture exceeds 64 characters/,
    );
    expectDecodeError(
      () => decodeDumpCatalogEntry({ ...encoded, exceptionCode: 4_294_967_296 }, "$"),
      /exceptionCode exceeds the maximum of 4294967295/,
    );
    expectDecodeError(
      () => decodeDumpCatalogEntry({ ...encoded, exceptionCode: 1.5 }, "$"),
      /exceptionCode must be a safe integer/,
    );
    expectDecodeError(
      () => decodeDumpCatalogEntry({ ...encoded, exceptionCode: "3221225477" }, "$"),
      /exceptionCode must be a number/,
    );
    expectDecodeError(
      () => decodeDumpCatalogEntry({ ...encoded, exceptionAddress: "0x7ff6" }, "$"),
      /exceptionAddress must be a canonical decimal string/,
    );
    expectDecodeError(
      () => decodeDumpCatalogEntry({ ...encoded, exceptionAddress: "007" }, "$"),
      /exceptionAddress must be a canonical decimal string/,
    );
    expectDecodeError(
      () => decodeDumpCatalogEntry({ ...encoded, symbolCoverage: { present: -1, missing: 0, unidentified: 0 } }, "$"),
      /symbolCoverage.present is below the minimum of 0/,
    );
    expectDecodeError(
      () => decodeDumpCatalogEntry({ ...encoded, symbolCoverage: { present: 0, missing: 0 } }, "$"),
      /missing required field/,
    );
    expectDecodeError(
      () => decodeDumpCatalogEntry({ ...encoded, symbolCoverage: { present: 0, missing: 0, unidentified: 0, extra: 1 } }, "$"),
      /unexpected field/,
    );
  });
});

describe("dump catalog responses", () => {
  it("round-trips a fully populated page with a cursor", () => {
    const response: DumpCatalogResponse = { dumps: [fullEntry, minimalEntry], nextCursor: "keyset-cursor" };
    assert.deepEqual(roundTripJson(response, encodeDumpCatalogResponse, decodeDumpCatalogResponse), response);
  });

  it("round-trips a minimal page without a cursor", () => {
    const response: DumpCatalogResponse = { dumps: [minimalEntry] };
    assert.deepEqual(roundTripJson(response, encodeDumpCatalogResponse, decodeDumpCatalogResponse), response);
  });

  it("omits an absent nextCursor when encoded and decoded", () => {
    const encoded = encodeDumpCatalogResponse({ dumps: [] });
    assert.ok(!("nextCursor" in encoded));
    const decoded = decodeDumpCatalogResponse(encoded, "$");
    assert.ok(!("nextCursor" in decoded));
    assert.deepEqual(decoded, { dumps: [] });
  });

  it("rejects missing, extra, and wrong-typed page fields", () => {
    expectDecodeError(() => decodeDumpCatalogResponse({}, "$"), /missing required field/);
    expectDecodeError(() => decodeDumpCatalogResponse({ dumps: "none" }, "$"), /dumps must be an array/);
    expectDecodeError(() => decodeDumpCatalogResponse({ dumps: [], extra: true }, "$"), /unexpected field/);
  });

  it("rejects malformed cursors and oversized pages", () => {
    expectDecodeError(
      () => decodeDumpCatalogResponse({ dumps: [], nextCursor: "c".repeat(MAX_CATALOG_CURSOR_LENGTH + 1) }, "$"),
      /nextCursor exceeds 256 characters/,
    );
    expectDecodeError(() => decodeDumpCatalogResponse({ dumps: [], nextCursor: "two words" }, "$"), /nextCursor is malformed/);
    const encoder = (): Record<string, unknown> => encodeDumpCatalogEntry(minimalEntry);
    const tooMany = { dumps: Array.from({ length: 4097 }, encoder) };
    expectDecodeError(() => decodeDumpCatalogResponse(tooMany, "$"), /dumps exceeds 4096 items/);
    const maximum = { dumps: Array.from({ length: 4096 }, encoder) };
    assert.equal(decodeDumpCatalogResponse(maximum, "$").dumps.length, 4096);
  });

  it("exposes the 200-item page cap", () => {
    assert.equal(MAX_CATALOG_PAGE, 200);
  });
});
