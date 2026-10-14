/**
 * Event feed contracts (analyzer-integration design: "Event feed"; milestone
 * AI2).
 *
 *   GET /api/v1/events -> EventFeedResponse
 *
 * `decodeEventFeedParams` decodes the feed query bag: `since` is an opaque
 * position cursor (the zero-padded rowid of the last delivered event),
 * `actions` filters the audit action vocabulary (comma-separated), `caseId`
 * filters one case, and `limit` resolves to `1..MAX_EVENTS_PAGE` with an
 * absent value meaning the maximum. Each parameter may appear at most once and
 * unknown parameters are rejected like every other shared decoder.
 *
 * The feed reads an append-only ledger, so `nextCursor` is always present: at
 * the live edge it echoes the request position (the request `since`, or the
 * last delivered cursor), which is how a poller sleeps between pages.
 * `detail` carries the audit payload — identifiers and outcomes, never dump
 * bytes or secret tokens — and is bounded to {@link MAX_EVENT_DETAIL_BYTES} of
 * compact JSON so the response contract enforces that sensitivity invariant
 * mechanically.
 */

import {
  arrayOf,
  canonicalTimestamp,
  childPath,
  fail,
  field,
  identifierField,
  isRecord,
  MAX_JSON_DEPTH,
  nullableField,
  object,
  text,
  type Decoder,
} from "./decode.js";

/** Most events one feed page may carry (server page cap and default). */
export const MAX_EVENTS_PAGE = 500;

/** Longest accepted serialized `detail` payload, in compact-JSON UTF-8 bytes. */
export const MAX_EVENT_DETAIL_BYTES = 4096;

/** Longest accepted cursor (`since`, entry `cursor`, and `nextCursor`). */
const MAX_EVENT_CURSOR_LENGTH = 256;

/** Longest accepted audit action, both in the `actions` filter and on rows. */
const MAX_EVENT_ACTION_LENGTH = 64;

/** Most entries the comma-separated `actions` filter may carry. */
const MAX_ACTION_FILTER_ENTRIES = 32;

/** Character ceiling for the raw `actions` string before it is split. */
const MAX_ACTION_FILTER_LENGTH = 4096;

/**
 * Hard ceiling for one decoded `events` array, bounded at 4096 like the
 * existing detail responses; the operational page cap is {@link MAX_EVENTS_PAGE}.
 */
const MAX_EVENT_RESPONSE_ITEMS = 4096;

/** Canonical non-negative integer text (no sign, leading zeros, or fraction). */
const CANONICAL_UINT_PATTERN = /^(0|[1-9][0-9]*)$/;

/** Opaque cursor token: non-empty, bounded, and free of whitespace. */
function cursorField(label: string): Decoder<string> {
  return text({ max: MAX_EVENT_CURSOR_LENGTH, label, pattern: /^\S+$/ });
}

/** `GET /api/v1/events` query parameters, decoded from URLSearchParams. */
export interface EventFeedParams {
  /** Opaque cursor (`≤ 256` non-whitespace characters); absent means "from the beginning". */
  readonly since?: string;
  /** Audit action filter (`≤ 32` entries of `1..64` characters); absent means all actions. */
  readonly actions?: readonly string[];
  /** Exact case filter. */
  readonly caseId?: string;
  /** Resolved page size in `1..500`; an absent parameter resolves to the maximum. */
  readonly limit: number;
}

const EVENT_FEED_PARAM_KEYS: readonly string[] = ["since", "actions", "caseId", "limit"];

/** Decodes one optional query parameter; array values mean a duplicate. */
function decodeQueryParam<T>(
  params: Readonly<Record<string, string | readonly string[] | undefined>>,
  key: string,
  decoder: Decoder<T>,
): T | undefined {
  const value = params[key];
  if (value === undefined) return undefined;
  if (Array.isArray(value)) fail(`$.${key}`, `${key} must appear at most once`);
  return decoder(value, `$.${key}`);
}

/** Comma-separated action filter; entries reject empty, overlong, and control values. */
const decodeEventActionsParam: Decoder<readonly string[]> = (value, path) => {
  const raw = text({ min: 0, max: MAX_ACTION_FILTER_LENGTH, label: "actions" })(value, path);
  return arrayOf(text({ max: MAX_EVENT_ACTION_LENGTH, label: "actions entry" }), {
    label: "actions",
    maxLength: MAX_ACTION_FILTER_ENTRIES,
  })(raw.split(","), path);
};

/** Canonical integer text resolved into the `1..MAX_EVENTS_PAGE` page range. */
const decodeEventLimitParam: Decoder<number> = (value, path) => {
  const decoded = text({ max: 10, label: "limit", pattern: CANONICAL_UINT_PATTERN })(value, path);
  const limit = Number(decoded);
  if (limit < 1 || limit > MAX_EVENTS_PAGE) {
    fail(path, `limit must be between 1 and ${MAX_EVENTS_PAGE}`);
  }
  return limit;
};

export function decodeEventFeedParams(
  params: Readonly<Record<string, string | readonly string[] | undefined>>,
): EventFeedParams {
  for (const key of Object.keys(params)) {
    if (!EVENT_FEED_PARAM_KEYS.includes(key)) fail(childPath("$", key), "unexpected query parameter");
  }
  const since = decodeQueryParam(params, "since", cursorField("since"));
  const actions = decodeQueryParam(params, "actions", decodeEventActionsParam);
  const caseId = decodeQueryParam(params, "caseId", identifierField("caseId"));
  const limit = decodeQueryParam(params, "limit", decodeEventLimitParam);
  return {
    ...(since === undefined ? {} : { since }),
    ...(actions === undefined ? {} : { actions }),
    ...(caseId === undefined ? {} : { caseId }),
    limit: limit ?? MAX_EVENTS_PAGE,
  };
}

/**
 * Validates that a value is a plain JSON tree: no `undefined`, functions,
 * symbols, bigints, non-finite numbers, or exotic objects. Containers deeper
 * than {@link MAX_JSON_DEPTH} reject so serialization stays total.
 */
function assertJsonValue(value: unknown, path: string, depth: number): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(path, "detail must contain only finite JSON numbers");
    return;
  }
  if (Array.isArray(value)) {
    if (depth >= MAX_JSON_DEPTH) fail(path, "detail exceeds the maximum nesting depth");
    for (let index = 0; index < value.length; index += 1) {
      assertJsonValue(value[index], childPath(path, index), depth + 1);
    }
    return;
  }
  if (isRecord(value)) {
    if (depth >= MAX_JSON_DEPTH) fail(path, "detail exceeds the maximum nesting depth");
    for (const key of Object.keys(value)) {
      assertJsonValue(value[key], childPath(path, key), depth + 1);
    }
    return;
  }
  fail(path, "detail must contain only JSON values");
}

/**
 * UTF-8 byte length of a string, matching `Buffer.byteLength(value, "utf8")`
 * without importing a runtime global; a surrogate pair counts four bytes.
 */
function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      bytes += next >= 0xdc00 && next <= 0xdfff ? 4 : 3;
      if (next >= 0xdc00 && next <= 0xdfff) index += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/**
 * Audit detail: a JSON object whose compact serialization (`JSON.stringify`
 * with no spacing) fits {@link MAX_EVENT_DETAIL_BYTES} UTF-8 bytes.
 */
const decodeEventDetail: Decoder<Readonly<Record<string, unknown>>> = (value, path) => {
  if (!isRecord(value)) fail(path, "detail must be a JSON object");
  assertJsonValue(value, path, 0);
  const serialized = JSON.stringify(value);
  if (utf8ByteLength(serialized) > MAX_EVENT_DETAIL_BYTES) {
    fail(path, `detail exceeds ${MAX_EVENT_DETAIL_BYTES} serialized bytes`);
  }
  return value;
};

/** One event row of a feed page (`GET /api/v1/events`). */
export interface EventFeedEntry {
  /** Position of this row; pass back as `?since=` to resume strictly after it. */
  readonly cursor: string;
  readonly eventId: string;
  readonly occurredAt: string;
  /** Audit action name (`1..64` characters). */
  readonly action: string;
  readonly customerId: string | null;
  readonly caseId: string | null;
  readonly dumpId: string | null;
  /** Audit payload: identifiers and outcomes, bounded and opaque to the wire. */
  readonly detail: Readonly<Record<string, unknown>>;
}

const eventFeedEntryShape = {
  cursor: field(cursorField("cursor")),
  eventId: field(identifierField("eventId")),
  occurredAt: field(canonicalTimestamp("occurredAt")),
  action: field(text({ max: MAX_EVENT_ACTION_LENGTH, label: "action" })),
  customerId: field(nullableField(identifierField("customerId"))),
  caseId: field(nullableField(identifierField("caseId"))),
  dumpId: field(nullableField(identifierField("dumpId"))),
  detail: field(decodeEventDetail),
} as const;

export const decodeEventFeedEntry: Decoder<EventFeedEntry> = (value, path) => {
  const decoded = object(eventFeedEntryShape, "event feed entry")(value, path);
  return {
    cursor: decoded.cursor,
    eventId: decoded.eventId,
    occurredAt: decoded.occurredAt,
    action: decoded.action,
    customerId: decoded.customerId,
    caseId: decoded.caseId,
    dumpId: decoded.dumpId,
    detail: decoded.detail,
  };
};

export function encodeEventFeedEntry(entry: EventFeedEntry): Record<string, unknown> {
  return {
    cursor: entry.cursor,
    eventId: entry.eventId,
    occurredAt: entry.occurredAt,
    action: entry.action,
    customerId: entry.customerId,
    caseId: entry.caseId,
    dumpId: entry.dumpId,
    detail: entry.detail,
  };
}

/** `GET /api/v1/events` body: one cursor-ordered page of audit events. */
export interface EventFeedResponse {
  readonly events: readonly EventFeedEntry[];
  /**
   * Always present. If `events` is non-empty this is the last delivered
   * cursor; otherwise it echoes the request position (the live edge), so a
   * poller can immediately re-issue the same request after sleeping.
   */
  readonly nextCursor: string;
}

export const decodeEventFeedResponse: Decoder<EventFeedResponse> = (value, path) => {
  const decoded = object(
    {
      events: field(arrayOf(decodeEventFeedEntry, { label: "events", maxLength: MAX_EVENT_RESPONSE_ITEMS })),
      nextCursor: field(cursorField("nextCursor")),
    },
    "event feed response",
  )(value, path);
  return { events: decoded.events, nextCursor: decoded.nextCursor };
};

export function encodeEventFeedResponse(response: EventFeedResponse): Record<string, unknown> {
  return {
    events: response.events.map(encodeEventFeedEntry),
    nextCursor: response.nextCursor,
  };
}
