import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DecodeError,
  MAX_EVENT_DETAIL_BYTES,
  MAX_EVENTS_PAGE,
  decodeEventFeedEntry,
  decodeEventFeedParams,
  decodeEventFeedResponse,
  decodeJsonText,
  encodeEventFeedEntry,
  encodeEventFeedResponse,
  toJsonText,
  type Decoder,
  type EventFeedEntry,
  type EventFeedParams,
  type EventFeedResponse,
} from "../src/index.js";

const ID_EVENT = "evt_01JTEST0000000000000000000";
const ID_CUSTOMER = "customer_01JTEST0000000000000000000";
const ID_CASE = "case_01JTEST0000000000000000000";
const ID_DUMP = "dump_01JTEST0000000000000000000";
const NOW = "2026-01-15T10:30:00.123Z";
const CURSOR = "0000000000000042";
const NEXT_CURSOR = "0000000000000043";

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

/** A detail object whose compact serialization is exactly `bytes` ASCII characters. */
function detailOfSerializedSize(bytes: number): Record<string, unknown> {
  const empty = toJsonText({ note: "" });
  const detail = { note: "x".repeat(bytes - empty.length) };
  assert.equal(toJsonText(detail).length, bytes);
  return detail;
}

const fullEntry: EventFeedEntry = {
  cursor: CURSOR,
  eventId: ID_EVENT,
  occurredAt: NOW,
  action: "SealUpload",
  customerId: ID_CUSTOMER,
  caseId: ID_CASE,
  dumpId: ID_DUMP,
  detail: {
    dumpId: ID_DUMP,
    byteSize: "73400320",
    nested: { tags: ["a", "b"], ok: true, count: 3, note: null },
  },
};

const minimalEntry: EventFeedEntry = {
  cursor: CURSOR,
  eventId: ID_EVENT,
  occurredAt: NOW,
  action: "CreateCustomer",
  customerId: null,
  caseId: null,
  dumpId: null,
  detail: {},
};

describe("event feed params", () => {
  it("resolves the empty query bag to the default page size", () => {
    assert.deepEqual(decodeEventFeedParams({}), { limit: MAX_EVENTS_PAGE });
    assert.equal(MAX_EVENTS_PAGE, 500);
  });

  it("accepts every parameter with valid values", () => {
    const bag: Record<string, string | readonly string[] | undefined> = {
      since: "c".repeat(256),
      actions: "SealUpload,RejectDump",
      caseId: ID_CASE,
      limit: "17",
    };
    const expected: EventFeedParams = {
      since: "c".repeat(256),
      actions: ["SealUpload", "RejectDump"],
      caseId: ID_CASE,
      limit: 17,
    };
    assert.deepEqual(decodeEventFeedParams(bag), expected);
  });

  it("treats undefined-valued known parameters as absent", () => {
    assert.deepEqual(
      decodeEventFeedParams({ since: undefined, actions: undefined, caseId: undefined, limit: undefined }),
      { limit: MAX_EVENTS_PAGE },
    );
  });

  it("bounds the since cursor", () => {
    expectDecodeError(() => decodeEventFeedParams({ since: "" }), /since must not be empty/);
    expectDecodeError(() => decodeEventFeedParams({ since: "two words" }), /since is malformed/);
    expectDecodeError(() => decodeEventFeedParams({ since: "c".repeat(257) }), /since exceeds 256 characters/);
    assert.deepEqual(decodeEventFeedParams({ since: "0000000000000000" }), {
      since: "0000000000000000",
      limit: MAX_EVENTS_PAGE,
    });
  });

  it("rejects malformed case filters", () => {
    expectDecodeError(() => decodeEventFeedParams({ caseId: "" }), /caseId must not be empty/);
    expectDecodeError(() => decodeEventFeedParams({ caseId: "two words" }), /caseId is malformed/);
    assert.deepEqual(decodeEventFeedParams({ caseId: ID_CASE }), { caseId: ID_CASE, limit: MAX_EVENTS_PAGE });
  });

  it("decodes the comma-separated actions filter", () => {
    assert.deepEqual(decodeEventFeedParams({ actions: "SealUpload" }), {
      actions: ["SealUpload"],
      limit: MAX_EVENTS_PAGE,
    });
    assert.deepEqual(decodeEventFeedParams({ actions: "SealUpload,RejectDump" }), {
      actions: ["SealUpload", "RejectDump"],
      limit: MAX_EVENTS_PAGE,
    });
  });

  it("accepts 32 action entries of up to 64 characters", () => {
    const entries = Array.from({ length: 32 }, (_, index) =>
      `action${index}`.padEnd(index === 31 ? 64 : 8, "x"),
    );
    const decoded = decodeEventFeedParams({ actions: entries.join(",") });
    assert.deepEqual(decoded.actions, entries);
    assert.equal(decoded.actions?.[31]?.length, 64);
  });

  it("rejects empty and overlong entries in the actions filter", () => {
    expectDecodeError(() => decodeEventFeedParams({ actions: "" }), /actions entry must not be empty/);
    expectDecodeError(() => decodeEventFeedParams({ actions: "a," }), /actions entry must not be empty/);
    expectDecodeError(() => decodeEventFeedParams({ actions: ",a" }), /actions entry must not be empty/);
    expectDecodeError(() => decodeEventFeedParams({ actions: "a,,b" }), /actions entry must not be empty/);
    expectDecodeError(() => decodeEventFeedParams({ actions: "a".repeat(65) }), /actions entry exceeds 64 characters/);
    assert.deepEqual(decodeEventFeedParams({ actions: "a".repeat(64) }), {
      actions: ["a".repeat(64)],
      limit: MAX_EVENTS_PAGE,
    });
  });

  it("rejects an actions list with more than 32 entries", () => {
    const entries = Array.from({ length: 33 }, (_, index) => `action${index}`);
    expectDecodeError(() => decodeEventFeedParams({ actions: entries.join(",") }), /actions exceeds 32 items/);
  });

  it("resolves and bounds the limit parameter", () => {
    assert.deepEqual(decodeEventFeedParams({ limit: "1" }), { limit: 1 });
    assert.deepEqual(decodeEventFeedParams({ limit: "499" }), { limit: 499 });
    assert.deepEqual(decodeEventFeedParams({ limit: "500" }), { limit: 500 });
    expectDecodeError(() => decodeEventFeedParams({ limit: "0" }), /limit must be between 1 and 500/);
    expectDecodeError(() => decodeEventFeedParams({ limit: "501" }), /limit must be between 1 and 500/);
    expectDecodeError(() => decodeEventFeedParams({ limit: "1.5" }), /limit is malformed/);
    expectDecodeError(() => decodeEventFeedParams({ limit: "abc" }), /limit is malformed/);
    expectDecodeError(() => decodeEventFeedParams({ limit: "" }), /limit must not be empty/);
    expectDecodeError(() => decodeEventFeedParams({ limit: "007" }), /limit is malformed/);
    expectDecodeError(() => decodeEventFeedParams({ limit: "-1" }), /limit is malformed/);
  });

  it("rejects duplicated parameters", () => {
    for (const key of ["since", "actions", "caseId", "limit"]) {
      const duplicates: Record<string, string | readonly string[] | undefined> = { [key]: ["a", "b"] };
      expectDecodeError(() => decodeEventFeedParams(duplicates), /must appear at most once/);
    }
  });

  it("rejects unknown parameters", () => {
    expectDecodeError(() => decodeEventFeedParams({ wait: "1000" }), /unexpected query parameter/);
    expectDecodeError(() => decodeEventFeedParams({ Since: "1" }), /unexpected query parameter/);
    expectDecodeError(() => decodeEventFeedParams({ since: "1", unknown: undefined }), /unexpected query parameter/);
  });
});

describe("event feed entries", () => {
  it("round-trips a fully populated entry", () => {
    assert.deepEqual(roundTripJson(fullEntry, encodeEventFeedEntry, decodeEventFeedEntry), fullEntry);
  });

  it("round-trips a minimal entry with null associations and empty detail", () => {
    assert.deepEqual(roundTripJson(minimalEntry, encodeEventFeedEntry, decodeEventFeedEntry), minimalEntry);
  });

  it("rejects missing, unknown, and wrong-typed fields", () => {
    const encoded = encodeEventFeedEntry(minimalEntry);
    expectDecodeError(() => decodeEventFeedEntry({}, "$"), /missing required field/);
    expectDecodeError(() => decodeEventFeedEntry({ ...encoded, extra: true }, "$"), /unexpected field/);
    expectDecodeError(() => decodeEventFeedEntry({ ...encoded, eventId: "" }, "$"), /eventId must not be empty/);
    expectDecodeError(
      () => decodeEventFeedEntry({ ...encoded, occurredAt: "now" }, "$"),
      /occurredAt is not a canonical UTC timestamp/,
    );
    expectDecodeError(
      () => decodeEventFeedEntry({ ...encoded, occurredAt: "2026-01-15T10:30:00Z" }, "$"),
      /occurredAt is not a canonical UTC timestamp/,
    );
    expectDecodeError(() => decodeEventFeedEntry({ ...encoded, customerId: "two words" }, "$"), /customerId is malformed/);
    expectDecodeError(() => decodeEventFeedEntry({ ...encoded, caseId: 7 }, "$"), /caseId must be a string/);
    expectDecodeError(() => decodeEventFeedEntry({ ...encoded, dumpId: "has space" }, "$"), /dumpId is malformed/);
  });

  it("bounds the entry cursor and action", () => {
    const encoded = encodeEventFeedEntry(minimalEntry);
    expectDecodeError(() => decodeEventFeedEntry({ ...encoded, cursor: "" }, "$"), /cursor must not be empty/);
    expectDecodeError(() => decodeEventFeedEntry({ ...encoded, cursor: "two words" }, "$"), /cursor is malformed/);
    expectDecodeError(
      () => decodeEventFeedEntry({ ...encoded, cursor: "c".repeat(257) }, "$"),
      /cursor exceeds 256 characters/,
    );
    expectDecodeError(() => decodeEventFeedEntry({ ...encoded, action: "" }, "$"), /action must not be empty/);
    expectDecodeError(
      () => decodeEventFeedEntry({ ...encoded, action: "a".repeat(65) }, "$"),
      /action exceeds 64 characters/,
    );
    const decoded = decodeEventFeedEntry({ ...encoded, action: "a".repeat(64) }, "$");
    assert.equal(decoded.action.length, 64);
  });

  it("requires detail to be a JSON object and rejects non-JSON values", () => {
    const encoded = encodeEventFeedEntry(minimalEntry);
    expectDecodeError(() => decodeEventFeedEntry({ ...encoded, detail: null }, "$"), /detail must be a JSON object/);
    expectDecodeError(() => decodeEventFeedEntry({ ...encoded, detail: [1, 2] }, "$"), /detail must be a JSON object/);
    expectDecodeError(() => decodeEventFeedEntry({ ...encoded, detail: "text" }, "$"), /detail must be a JSON object/);
    expectDecodeError(
      () => decodeEventFeedEntry({ ...encoded, detail: { bad: undefined } }, "$"),
      /detail must contain only JSON values/,
    );
    expectDecodeError(() => decodeEventFeedEntry({ ...encoded, detail: { bad: 1n } }, "$"), /detail must contain only JSON values/);
    expectDecodeError(
      () => decodeEventFeedEntry({ ...encoded, detail: { bad: Number.NaN } }, "$"),
      /detail must contain only finite JSON numbers/,
    );
    expectDecodeError(
      () => decodeEventFeedEntry({ ...encoded, detail: { bad: Number.POSITIVE_INFINITY } }, "$"),
      /detail must contain only finite JSON numbers/,
    );
    expectDecodeError(
      () => decodeEventFeedEntry({ ...encoded, detail: { bad: (): number => 1 } }, "$"),
      /detail must contain only JSON values/,
    );
  });

  it("bounds detail at 4096 bytes of serialized JSON", () => {
    assert.equal(MAX_EVENT_DETAIL_BYTES, 4096);
    const encoded = encodeEventFeedEntry(minimalEntry);
    const fits = detailOfSerializedSize(MAX_EVENT_DETAIL_BYTES);
    assert.deepEqual(decodeEventFeedEntry({ ...encoded, detail: fits }, "$").detail, fits);
    const overflows = detailOfSerializedSize(MAX_EVENT_DETAIL_BYTES + 1);
    expectDecodeError(
      () => decodeEventFeedEntry({ ...encoded, detail: overflows }, "$"),
      /detail exceeds 4096 serialized bytes/,
    );
  });

  it("measures the detail bound in UTF-8 bytes rather than characters", () => {
    const encoded = encodeEventFeedEntry(minimalEntry);
    const heavy = { note: "é".repeat(2043) };
    assert.ok(toJsonText(heavy).length < MAX_EVENT_DETAIL_BYTES);
    assert.ok(Buffer.byteLength(toJsonText(heavy), "utf8") > MAX_EVENT_DETAIL_BYTES);
    expectDecodeError(
      () => decodeEventFeedEntry({ ...encoded, detail: heavy }, "$"),
      /detail exceeds 4096 serialized bytes/,
    );
    const fits = { note: "é".repeat(2042) };
    assert.equal(Buffer.byteLength(toJsonText(fits), "utf8"), MAX_EVENT_DETAIL_BYTES - 1);
    assert.deepEqual(decodeEventFeedEntry({ ...encoded, detail: fits }, "$").detail, fits);
  });
});

describe("event feed responses", () => {
  it("round-trips a fully populated page", () => {
    const response: EventFeedResponse = { events: [fullEntry, minimalEntry], nextCursor: NEXT_CURSOR };
    assert.deepEqual(roundTripJson(response, encodeEventFeedResponse, decodeEventFeedResponse), response);
  });

  it("round-trips a minimal page", () => {
    const response: EventFeedResponse = { events: [minimalEntry], nextCursor: CURSOR };
    assert.deepEqual(roundTripJson(response, encodeEventFeedResponse, decodeEventFeedResponse), response);
  });

  it("always carries nextCursor, even on an empty page", () => {
    const empty: EventFeedResponse = { events: [], nextCursor: "0000000000000000" };
    const encoded = encodeEventFeedResponse(empty);
    assert.ok("nextCursor" in encoded);
    const decoded = roundTripJson(empty, encodeEventFeedResponse, decodeEventFeedResponse);
    assert.ok("nextCursor" in decoded);
    assert.deepEqual(decoded, empty);
    expectDecodeError(() => decodeEventFeedResponse({ events: [] }, "$"), /missing required field/);
    expectDecodeError(
      () => decodeEventFeedResponse({ events: [], nextCursor: undefined }, "$"),
      /field must not be undefined/,
    );
  });

  it("bounds and validates nextCursor", () => {
    expectDecodeError(() => decodeEventFeedResponse({ events: [], nextCursor: "" }, "$"), /nextCursor must not be empty/);
    expectDecodeError(
      () => decodeEventFeedResponse({ events: [], nextCursor: "two words" }, "$"),
      /nextCursor is malformed/,
    );
    expectDecodeError(
      () => decodeEventFeedResponse({ events: [], nextCursor: "c".repeat(257) }, "$"),
      /nextCursor exceeds 256 characters/,
    );
  });

  it("rejects unknown, missing, and wrong-typed page fields", () => {
    expectDecodeError(() => decodeEventFeedResponse({}, "$"), /missing required field/);
    expectDecodeError(
      () => decodeEventFeedResponse({ events: "none", nextCursor: CURSOR }, "$"),
      /events must be an array/,
    );
    expectDecodeError(
      () => decodeEventFeedResponse({ events: [], nextCursor: CURSOR, extra: true }, "$"),
      /unexpected field/,
    );
    expectDecodeError(() => decodeEventFeedResponse({ events: [], nextCursor: 42 }, "$"), /nextCursor must be a string/);
  });

  it("bounds the events array at 4096 items", () => {
    const encoder = (): Record<string, unknown> => encodeEventFeedEntry(minimalEntry);
    const tooMany = { events: Array.from({ length: 4097 }, encoder), nextCursor: CURSOR };
    expectDecodeError(() => decodeEventFeedResponse(tooMany, "$"), /events exceeds 4096 items/);
    const maximum = { events: Array.from({ length: 4096 }, encoder), nextCursor: CURSOR };
    assert.equal(decodeEventFeedResponse(maximum, "$").events.length, 4096);
  });

  it("exposes the 500-event page cap", () => {
    assert.equal(MAX_EVENTS_PAGE, 500);
  });
});
