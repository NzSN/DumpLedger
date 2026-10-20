import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DecodeError,
  MAX_TEXT_LENGTH,
  MAX_WEBHOOK_ACTION_FILTER_ENTRIES,
  MAX_WEBHOOK_ACTION_LENGTH,
  MAX_WEBHOOK_RESPONSE_ITEMS,
  MAX_WEBHOOK_URL_LENGTH,
  WEBHOOK_DELIVERY_STATUSES,
  decodeCreateWebhookParams,
  decodeCreateWebhookResponse,
  decodeJsonText,
  decodeWebhookDeliveriesResponse,
  decodeWebhookDelivery,
  decodeWebhookListResponse,
  decodeWebhookSubscription,
  encodeCreateWebhookParams,
  encodeCreateWebhookResponse,
  encodeWebhookDeliveriesResponse,
  encodeWebhookDelivery,
  encodeWebhookListResponse,
  encodeWebhookSubscription,
  toJsonText,
  type CreateWebhookParams,
  type CreateWebhookResponse,
  type Decoder,
  type WebhookDeliveriesResponse,
  type WebhookDelivery,
  type WebhookListResponse,
  type WebhookSubscription,
} from "../src/index.js";

const ID_SUBSCRIPTION = "whs_01JTEST0000000000000000000";
const ID_DELIVERY = "whd_01JTEST0000000000000000000";
const ID_CASE = "case_01JTEST0000000000000000000";
const ID_DUMP = "dump_01JTEST0000000000000000000";
const SECRET = "whsec_0123456789abcdefghijklmnopqrstuvwxyz";
const URL = "https://analyzer.example.test/hooks/dump-ledger";
const CURSOR = "0000000000000042";
const EVENT_CURSOR = "0000000000000041";
const NOW = "2026-01-15T10:30:00.123Z";
const NEXT_ATTEMPT = "2026-01-15T10:30:10.123Z";

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

function withoutKeys(record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const copy = { ...record };
  for (const key of keys) delete copy[key];
  return copy;
}

const maxUrl = `https://example.test/${"a".repeat(MAX_WEBHOOK_URL_LENGTH - "https://example.test/".length)}`;
const maxActions = Array.from({ length: MAX_WEBHOOK_ACTION_FILTER_ENTRIES }, (_, index) =>
  index === MAX_WEBHOOK_ACTION_FILTER_ENTRIES - 1
    ? `action${index}`.padEnd(MAX_WEBHOOK_ACTION_LENGTH, "x")
    : `action${index}`,
);

const fullCreateParams: CreateWebhookParams = {
  url: URL,
  actions: ["AcceptDump", "SealUpload"],
  caseId: ID_CASE,
};

const minimalCreateParams: CreateWebhookParams = { url: URL };

const fullSubscription: WebhookSubscription = {
  id: ID_SUBSCRIPTION,
  url: URL,
  actions: ["AcceptDump", "SealUpload"],
  caseId: ID_CASE,
  cursor: CURSOR,
  createdAt: NOW,
};

const unfilteredSubscription: WebhookSubscription = {
  id: ID_SUBSCRIPTION,
  url: URL,
  actions: null,
  caseId: null,
  cursor: CURSOR,
  createdAt: NOW,
};

const pendingDelivery: WebhookDelivery = {
  id: ID_DELIVERY,
  subscriptionId: ID_SUBSCRIPTION,
  eventCursor: EVENT_CURSOR,
  action: "AcceptDump",
  dumpId: ID_DUMP,
  status: "pending",
  attempts: 2,
  lastStatusCode: 503,
  lastError: "receiver unavailable",
  nextAttemptAt: NEXT_ATTEMPT,
  deliveredAt: null,
  createdAt: NOW,
};

const deliveredDelivery: WebhookDelivery = {
  id: ID_DELIVERY,
  subscriptionId: ID_SUBSCRIPTION,
  eventCursor: EVENT_CURSOR,
  action: "AcceptDump",
  dumpId: null,
  status: "delivered",
  attempts: 1,
  lastStatusCode: 204,
  lastError: null,
  nextAttemptAt: null,
  deliveredAt: NEXT_ATTEMPT,
  createdAt: NOW,
};

const exhaustedDelivery: WebhookDelivery = {
  id: ID_DELIVERY,
  subscriptionId: ID_SUBSCRIPTION,
  eventCursor: EVENT_CURSOR,
  action: "AcceptDump",
  dumpId: null,
  status: "exhausted",
  attempts: 5,
  lastStatusCode: null,
  lastError: null,
  nextAttemptAt: null,
  deliveredAt: null,
  createdAt: NOW,
};

describe("create webhook params", () => {
  it("round-trips fully populated and minimal requests", () => {
    assert.deepEqual(roundTripJson(fullCreateParams, encodeCreateWebhookParams, decodeCreateWebhookParams), fullCreateParams);
    assert.deepEqual(roundTripJson(minimalCreateParams, encodeCreateWebhookParams, decodeCreateWebhookParams), minimalCreateParams);
  });

  it("leaves absent optional filters absent", () => {
    const encoded = encodeCreateWebhookParams(minimalCreateParams);
    assert.ok(!("actions" in encoded));
    assert.ok(!("caseId" in encoded));
    const decoded = decodeCreateWebhookParams({ url: URL }, "$");
    assert.ok(!("actions" in decoded));
    assert.ok(!("caseId" in decoded));
  });

  it("rejects explicit null for optional filters", () => {
    expectDecodeError(() => decodeCreateWebhookParams({ url: URL, actions: null }, "$"), /actions must be an array/);
    expectDecodeError(() => decodeCreateWebhookParams({ url: URL, caseId: null }, "$"), /caseId must be a string/);
  });

  it("rejects missing, unknown, and wrong-typed fields", () => {
    expectDecodeError(() => decodeCreateWebhookParams({}, "$"), /missing required field/);
    expectDecodeError(() => decodeCreateWebhookParams([], "$"), /create webhook request must be a JSON object/);
    expectDecodeError(() => decodeCreateWebhookParams({ url: URL, extra: true }, "$"), /unexpected field/);
    expectDecodeError(() => decodeCreateWebhookParams({ url: 42 }, "$"), /url must be a string/);
    expectDecodeError(() => decodeCreateWebhookParams({ url: URL, actions: "AcceptDump" }, "$"), /actions must be an array/);
    expectDecodeError(() => decodeCreateWebhookParams({ url: URL, caseId: 42 }, "$"), /caseId must be a string/);
  });

  it("bounds URL length and rejects whitespace", () => {
    assert.equal(decodeCreateWebhookParams({ url: maxUrl }, "$").url.length, MAX_WEBHOOK_URL_LENGTH);
    expectDecodeError(() => decodeCreateWebhookParams({ url: "" }, "$"), /url must not be empty/);
    expectDecodeError(() => decodeCreateWebhookParams({ url: "two words" }, "$"), /url is malformed/);
    expectDecodeError(
      () => decodeCreateWebhookParams({ url: `${maxUrl}a` }, "$"),
      /url exceeds 2048 characters/,
    );
  });

  it("bounds the action filter at 32 non-whitespace entries of up to 64 characters", () => {
    const decoded = decodeCreateWebhookParams({ url: URL, actions: maxActions }, "$");
    assert.equal(decoded.actions?.length, MAX_WEBHOOK_ACTION_FILTER_ENTRIES);
    assert.equal(decoded.actions?.[MAX_WEBHOOK_ACTION_FILTER_ENTRIES - 1]?.length, MAX_WEBHOOK_ACTION_LENGTH);
    assert.deepEqual(decodeCreateWebhookParams({ url: URL, actions: [] }, "$").actions, []);
    expectDecodeError(
      () => decodeCreateWebhookParams({ url: URL, actions: [...maxActions, "one-too-many"] }, "$"),
      /actions exceeds 32 items/,
    );
    expectDecodeError(() => decodeCreateWebhookParams({ url: URL, actions: [""] }, "$"), /actions entry must not be empty/);
    expectDecodeError(
      () => decodeCreateWebhookParams({ url: URL, actions: ["two words"] }, "$"),
      /actions entry is malformed/,
    );
    expectDecodeError(
      () => decodeCreateWebhookParams({ url: URL, actions: ["a".repeat(MAX_WEBHOOK_ACTION_LENGTH + 1)] }, "$"),
      /actions entry exceeds 64 characters/,
    );
  });

  it("decodes caseId like every other identifier", () => {
    expectDecodeError(() => decodeCreateWebhookParams({ url: URL, caseId: "" }, "$"), /caseId must not be empty/);
    expectDecodeError(() => decodeCreateWebhookParams({ url: URL, caseId: "two words" }, "$"), /caseId is malformed/);
    expectDecodeError(
      () => decodeCreateWebhookParams({ url: URL, caseId: "c".repeat(129) }, "$"),
      /caseId exceeds 128 characters/,
    );
  });
});

describe("webhook subscriptions", () => {
  it("round-trips filtered and unfiltered subscriptions", () => {
    assert.deepEqual(roundTripJson(fullSubscription, encodeWebhookSubscription, decodeWebhookSubscription), fullSubscription);
    assert.deepEqual(
      roundTripJson(unfilteredSubscription, encodeWebhookSubscription, decodeWebhookSubscription),
      unfilteredSubscription,
    );
  });

  it("uses null, not absence, for nullable subscription fields", () => {
    const encoded = encodeWebhookSubscription(unfilteredSubscription);
    assert.ok("actions" in encoded);
    assert.equal(encoded.actions, null);
    assert.ok("caseId" in encoded);
    assert.equal(encoded.caseId, null);
    for (const key of ["actions", "caseId"]) {
      expectDecodeError(
        () => decodeWebhookSubscription(withoutKeys(encoded, [key]), "$"),
        /missing required field/,
      );
    }
    assert.deepEqual(
      decodeWebhookSubscription({ ...encodeWebhookSubscription(fullSubscription), actions: null }, "$").actions,
      null,
    );
    assert.deepEqual(
      decodeWebhookSubscription({ ...encodeWebhookSubscription(fullSubscription), caseId: null }, "$").caseId,
      null,
    );
  });

  it("never accepts a secret on the subscription shape", () => {
    const encoded = encodeWebhookSubscription(fullSubscription);
    assert.ok(!("secret" in encoded));
    expectDecodeError(() => decodeWebhookSubscription({ ...encoded, secret: SECRET }, "$"), /unexpected field/);
  });

  it("validates the cursor as a zero-padded 16-digit rowid", () => {
    const encoded = encodeWebhookSubscription(unfilteredSubscription);
    assert.equal(decodeWebhookSubscription({ ...encoded, cursor: "0000000000000000" }, "$").cursor, "0000000000000000");
    expectDecodeError(() => decodeWebhookSubscription({ ...encoded, cursor: "" }, "$"), /cursor must not be empty/);
    expectDecodeError(
      () => decodeWebhookSubscription({ ...encoded, cursor: "000000000000042" }, "$"),
      /cursor is malformed/,
    );
    expectDecodeError(
      () => decodeWebhookSubscription({ ...encoded, cursor: "00000000000000420" }, "$"),
      /cursor exceeds 16 characters/,
    );
    expectDecodeError(
      () => decodeWebhookSubscription({ ...encoded, cursor: "00000000000000x2" }, "$"),
      /cursor is malformed/,
    );
  });

  it("rejects malformed rows", () => {
    const encoded = encodeWebhookSubscription(unfilteredSubscription);
    expectDecodeError(() => decodeWebhookSubscription({}, "$"), /missing required field/);
    expectDecodeError(() => decodeWebhookSubscription({ ...encoded, extra: true }, "$"), /unexpected field/);
    expectDecodeError(() => decodeWebhookSubscription({ ...encoded, id: "" }, "$"), /id must not be empty/);
    expectDecodeError(() => decodeWebhookSubscription({ ...encoded, id: "two words" }, "$"), /id is malformed/);
    expectDecodeError(() => decodeWebhookSubscription({ ...encoded, url: "two words" }, "$"), /url is malformed/);
    expectDecodeError(
      () => decodeWebhookSubscription({ ...encoded, actions: ["two words"] }, "$"),
      /actions entry is malformed/,
    );
    expectDecodeError(() => decodeWebhookSubscription({ ...encoded, caseId: "two words" }, "$"), /caseId is malformed/);
    expectDecodeError(
      () => decodeWebhookSubscription({ ...encoded, createdAt: "2026-01-15T10:30:00Z" }, "$"),
      /createdAt is not a canonical UTC timestamp/,
    );
  });
});

describe("create webhook responses", () => {
  it("round-trips the creation-time response with its secret", () => {
    const response: CreateWebhookResponse = { subscription: fullSubscription, secret: SECRET };
    assert.deepEqual(roundTripJson(response, encodeCreateWebhookResponse, decodeCreateWebhookResponse), response);
  });

  it("rejects missing, unknown, and malformed fields", () => {
    const encoded = encodeCreateWebhookResponse({ subscription: fullSubscription, secret: SECRET });
    expectDecodeError(() => decodeCreateWebhookResponse({ subscription: fullSubscription }, "$"), /missing required field/);
    expectDecodeError(() => decodeCreateWebhookResponse({ ...encoded, extra: true }, "$"), /unexpected field/);
    expectDecodeError(() => decodeCreateWebhookResponse({ ...encoded, secret: "" }, "$"), /secret must not be empty/);
    expectDecodeError(() => decodeCreateWebhookResponse({ ...encoded, secret: "two words" }, "$"), /secret is malformed/);
    expectDecodeError(
      () => decodeCreateWebhookResponse({ ...encoded, subscription: { ...fullSubscription, extra: true } }, "$"),
      /unexpected field/,
    );
  });
});

describe("webhook list responses", () => {
  it("round-trips populated and empty lists", () => {
    const populated: WebhookListResponse = { subscriptions: [fullSubscription, unfilteredSubscription] };
    const empty: WebhookListResponse = { subscriptions: [] };
    assert.deepEqual(roundTripJson(populated, encodeWebhookListResponse, decodeWebhookListResponse), populated);
    assert.deepEqual(roundTripJson(empty, encodeWebhookListResponse, decodeWebhookListResponse), empty);
  });

  it("bounds the subscriptions array at 4096 items", () => {
    const encoder = (): Record<string, unknown> => encodeWebhookSubscription(unfilteredSubscription);
    const tooMany = { subscriptions: Array.from({ length: MAX_WEBHOOK_RESPONSE_ITEMS + 1 }, encoder) };
    expectDecodeError(() => decodeWebhookListResponse(tooMany, "$"), /subscriptions exceeds 4096 items/);
    const maximum = { subscriptions: Array.from({ length: MAX_WEBHOOK_RESPONSE_ITEMS }, encoder) };
    assert.equal(decodeWebhookListResponse(maximum, "$").subscriptions.length, MAX_WEBHOOK_RESPONSE_ITEMS);
  });

  it("rejects missing, unknown, and wrong-typed page fields", () => {
    expectDecodeError(() => decodeWebhookListResponse({}, "$"), /missing required field/);
    expectDecodeError(() => decodeWebhookListResponse({ subscriptions: "none" }, "$"), /subscriptions must be an array/);
    expectDecodeError(() => decodeWebhookListResponse({ subscriptions: [], extra: true }, "$"), /unexpected field/);
    expectDecodeError(() => decodeWebhookListResponse({ subscriptions: [{}] }, "$"), /missing required field/);
  });
});

describe("webhook deliveries", () => {
  it("round-trips pending, delivered, and exhausted rows", () => {
    for (const delivery of [pendingDelivery, deliveredDelivery, exhaustedDelivery]) {
      assert.deepEqual(roundTripJson(delivery, encodeWebhookDelivery, decodeWebhookDelivery), delivery);
    }
  });

  it("accepts exactly the closed delivery-status vocabulary", () => {
    const encoded = encodeWebhookDelivery(exhaustedDelivery);
    assert.deepEqual([...WEBHOOK_DELIVERY_STATUSES], ["pending", "delivered", "exhausted"]);
    for (const status of WEBHOOK_DELIVERY_STATUSES) {
      assert.equal(decodeWebhookDelivery({ ...encoded, status }, "$").status, status);
    }
    expectDecodeError(() => decodeWebhookDelivery({ ...encoded, status: "failed" }, "$"), /status is invalid/);
    expectDecodeError(() => decodeWebhookDelivery({ ...encoded, status: null }, "$"), /status is invalid/);
    expectDecodeError(() => decodeWebhookDelivery({ ...encoded, status: 2 }, "$"), /status is invalid/);
  });

  it("uses null, not absence, for every nullable delivery field", () => {
    const nullableKeys = ["dumpId", "lastStatusCode", "lastError", "nextAttemptAt", "deliveredAt"];
    const encoded = encodeWebhookDelivery(exhaustedDelivery);
    for (const key of nullableKeys) {
      assert.ok(key in encoded, `${key} must always be encoded`);
      assert.equal(encoded[key], null);
      expectDecodeError(
        () => decodeWebhookDelivery(withoutKeys(encoded, [key]), "$"),
        /missing required field/,
      );
    }
    const nulled = decodeWebhookDelivery(
      {
        ...encodeWebhookDelivery(pendingDelivery),
        dumpId: null,
        lastStatusCode: null,
        lastError: null,
        nextAttemptAt: null,
        deliveredAt: null,
      },
      "$",
    );
    assert.equal(nulled.dumpId, null);
    assert.equal(nulled.lastStatusCode, null);
    assert.equal(nulled.lastError, null);
    assert.equal(nulled.nextAttemptAt, null);
    assert.equal(nulled.deliveredAt, null);
  });

  it("validates the event cursor and audit action", () => {
    const encoded = encodeWebhookDelivery(exhaustedDelivery);
    expectDecodeError(
      () => decodeWebhookDelivery({ ...encoded, eventCursor: "000000000000041" }, "$"),
      /eventCursor is malformed/,
    );
    expectDecodeError(() => decodeWebhookDelivery({ ...encoded, action: "" }, "$"), /action must not be empty/);
    expectDecodeError(
      () => decodeWebhookDelivery({ ...encoded, action: "a".repeat(MAX_WEBHOOK_ACTION_LENGTH + 1) }, "$"),
      /action exceeds 64 characters/,
    );
  });

  it("validates attempts and the last HTTP status code", () => {
    const encoded = encodeWebhookDelivery(exhaustedDelivery);
    assert.equal(decodeWebhookDelivery({ ...encoded, attempts: 0 }, "$").attempts, 0);
    expectDecodeError(() => decodeWebhookDelivery({ ...encoded, attempts: -1 }, "$"), /attempts is below the minimum/);
    expectDecodeError(() => decodeWebhookDelivery({ ...encoded, attempts: 1.5 }, "$"), /attempts must be a safe integer/);
    assert.equal(decodeWebhookDelivery({ ...encoded, lastStatusCode: 100 }, "$").lastStatusCode, 100);
    assert.equal(decodeWebhookDelivery({ ...encoded, lastStatusCode: 599 }, "$").lastStatusCode, 599);
    expectDecodeError(
      () => decodeWebhookDelivery({ ...encoded, lastStatusCode: 99 }, "$"),
      /lastStatusCode is below the minimum of 100/,
    );
    expectDecodeError(
      () => decodeWebhookDelivery({ ...encoded, lastStatusCode: 600 }, "$"),
      /lastStatusCode exceeds the maximum of 599/,
    );
  });

  it("bounds the last error and validates nullable timestamps", () => {
    const encoded = encodeWebhookDelivery(exhaustedDelivery);
    assert.equal(
      decodeWebhookDelivery({ ...encoded, lastError: "e".repeat(MAX_TEXT_LENGTH) }, "$").lastError?.length,
      MAX_TEXT_LENGTH,
    );
    expectDecodeError(
      () => decodeWebhookDelivery({ ...encoded, lastError: "e".repeat(MAX_TEXT_LENGTH + 1) }, "$"),
      /lastError exceeds 16384 characters/,
    );
    expectDecodeError(
      () => decodeWebhookDelivery({ ...encoded, nextAttemptAt: "2026-01-15T10:30:10Z" }, "$"),
      /nextAttemptAt is not a canonical UTC timestamp/,
    );
    expectDecodeError(
      () => decodeWebhookDelivery({ ...encoded, deliveredAt: "now" }, "$"),
      /deliveredAt is not a canonical UTC timestamp/,
    );
    expectDecodeError(
      () => decodeWebhookDelivery({ ...encoded, createdAt: "now" }, "$"),
      /createdAt is not a canonical UTC timestamp/,
    );
  });

  it("rejects missing, unknown, and wrong-typed row fields", () => {
    const encoded = encodeWebhookDelivery(exhaustedDelivery);
    expectDecodeError(() => decodeWebhookDelivery({}, "$"), /missing required field/);
    expectDecodeError(() => decodeWebhookDelivery({ ...encoded, extra: true }, "$"), /unexpected field/);
    expectDecodeError(() => decodeWebhookDelivery({ ...encoded, id: "two words" }, "$"), /id is malformed/);
    expectDecodeError(
      () => decodeWebhookDelivery({ ...encoded, subscriptionId: "two words" }, "$"),
      /subscriptionId is malformed/,
    );
    expectDecodeError(() => decodeWebhookDelivery({ ...encoded, dumpId: "two words" }, "$"), /dumpId is malformed/);
  });
});

describe("webhook deliveries responses", () => {
  it("round-trips populated and empty pages", () => {
    const populated: WebhookDeliveriesResponse = { deliveries: [pendingDelivery, deliveredDelivery, exhaustedDelivery] };
    const empty: WebhookDeliveriesResponse = { deliveries: [] };
    assert.deepEqual(
      roundTripJson(populated, encodeWebhookDeliveriesResponse, decodeWebhookDeliveriesResponse),
      populated,
    );
    assert.deepEqual(roundTripJson(empty, encodeWebhookDeliveriesResponse, decodeWebhookDeliveriesResponse), empty);
  });

  it("bounds the deliveries array at 4096 items", () => {
    const encoder = (): Record<string, unknown> => encodeWebhookDelivery(exhaustedDelivery);
    const tooMany = { deliveries: Array.from({ length: MAX_WEBHOOK_RESPONSE_ITEMS + 1 }, encoder) };
    expectDecodeError(() => decodeWebhookDeliveriesResponse(tooMany, "$"), /deliveries exceeds 4096 items/);
    const maximum = { deliveries: Array.from({ length: MAX_WEBHOOK_RESPONSE_ITEMS }, encoder) };
    assert.equal(
      decodeWebhookDeliveriesResponse(maximum, "$").deliveries.length,
      MAX_WEBHOOK_RESPONSE_ITEMS,
    );
  });

  it("rejects missing, unknown, and wrong-typed page fields", () => {
    expectDecodeError(() => decodeWebhookDeliveriesResponse({}, "$"), /missing required field/);
    expectDecodeError(
      () => decodeWebhookDeliveriesResponse({ deliveries: "none" }, "$"),
      /deliveries must be an array/,
    );
    expectDecodeError(
      () => decodeWebhookDeliveriesResponse({ deliveries: [], extra: true }, "$"),
      /unexpected field/,
    );
    expectDecodeError(
      () => decodeWebhookDeliveriesResponse({ deliveries: [{}] }, "$"),
      /missing required field/,
    );
  });
});
