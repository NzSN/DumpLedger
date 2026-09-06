/**
 * Case contracts (design sections 7.3 and 7.4): summaries, search, creation,
 * detail, and the five explicit lifecycle transitions.
 *
 * `allowedActions` on the case detail response is presentation guidance only,
 * never authorization. Every transition is re-checked inside the lifecycle
 * engine and its ledger transaction, and the server rejects illegal or
 * repeated actions with the stable `invalid_transition` error.
 */

import {
  arrayOf,
  canonicalDecimal,
  canonicalTimestamp,
  fail,
  field,
  identifierField,
  nullableField,
  object,
  optional,
  text,
  type Decoder,
} from "./decode.js";
import {
  caseActionDecoder,
  caseStatusDecoder,
  decodeActivityItem,
  decodeActivityItems,
  dumpPhaseDecoder,
  encodeActivityItem,
  grantStateDecoder,
  type ActivityItem,
  type CaseAction,
  type CaseStatus,
  type DumpPhase,
  type GrantState,
} from "./vocab.js";

export const MAX_CASE_TITLE_LENGTH = 300;
export const MAX_SEARCH_QUERY_LENGTH = 200;
export const MAX_CURSOR_LENGTH = 256;
export const MAX_CASE_LIST_ITEMS = 200;

/** One bounded row of the case search/dashboard recent list. */
export interface CaseSummary {
  readonly caseId: string;
  readonly customerId: string;
  readonly title: string;
  readonly status: CaseStatus;
  readonly createdAt: string;
}

const caseSummaryShape = {
  caseId: field(identifierField("caseId")),
  customerId: field(identifierField("customerId")),
  title: field(text({ max: MAX_CASE_TITLE_LENGTH, label: "title" })),
  status: field(caseStatusDecoder),
  createdAt: field(canonicalTimestamp("createdAt")),
} as const;

export const decodeCaseSummary: Decoder<CaseSummary> = (value, path) => {
  const decoded = object(caseSummaryShape, "case summary")(value, path);
  return {
    caseId: decoded.caseId,
    customerId: decoded.customerId,
    title: decoded.title,
    status: decoded.status,
    createdAt: decoded.createdAt,
  };
};

export function encodeCaseSummary(caseSummary: CaseSummary): Record<string, unknown> {
  return {
    caseId: caseSummary.caseId,
    customerId: caseSummary.customerId,
    title: caseSummary.title,
    status: caseSummary.status,
    createdAt: caseSummary.createdAt,
  };
}

/** `POST /api/v1/customers/:customerId/cases` body. */
export interface CreateCaseRequest {
  readonly title: string;
}

export const decodeCreateCaseRequest: Decoder<CreateCaseRequest> = (value, path) => {
  const decoded = object(
    { title: field(text({ max: MAX_CASE_TITLE_LENGTH, label: "title" })) },
    "create case request",
  )(value, path);
  return { title: decoded.title };
};

export function encodeCreateCaseRequest(request: CreateCaseRequest): Record<string, unknown> {
  return { title: request.title };
}

/** Create-case success is the resulting case summary (server state). */
export type CreateCaseResponse = CaseSummary;

export const decodeCreateCaseResponse: Decoder<CreateCaseResponse> = (value, path) =>
  decodeCaseSummary(value, path);

export function encodeCreateCaseResponse(response: CreateCaseResponse): Record<string, unknown> {
  return encodeCaseSummary(response);
}

/** `GET /api/v1/cases` query parameters. Values are decoded from URLSearchParams. */
export interface CaseSearchParams {
  readonly query?: string;
  readonly cursor?: string;
}

export function decodeCaseSearchParams(
  params: Readonly<Record<string, string | readonly string[] | undefined>>,
): CaseSearchParams {
  const queryValue = params.query;
  const cursorValue = params.cursor;
  let query: string | undefined;
  let cursor: string | undefined;
  if (queryValue !== undefined) {
    if (Array.isArray(queryValue)) fail("$.query", "search query must appear at most once");
    query = text({ min: 0, max: MAX_SEARCH_QUERY_LENGTH, label: "search query" })(queryValue, "$.query");
  }
  if (cursorValue !== undefined) {
    if (Array.isArray(cursorValue)) fail("$.cursor", "search cursor must appear at most once");
    cursor = text({ max: MAX_CURSOR_LENGTH, label: "cursor", pattern: /^\S+$/ })(cursorValue, "$.cursor");
  }
  return {
    ...(query === undefined ? {} : { query }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

export interface CaseSearchResponse {
  readonly cases: readonly CaseSummary[];
  readonly nextCursor?: string;
}

export const decodeCaseSearchResponse: Decoder<CaseSearchResponse> = (value, path) => {
  const decoded = object(
    {
      cases: field(arrayOf(decodeCaseSummary, { label: "cases", maxLength: MAX_CASE_LIST_ITEMS })),
      nextCursor: optional(text({ max: MAX_CURSOR_LENGTH, label: "nextCursor", pattern: /^\S+$/ })),
    },
    "case search response",
  )(value, path);
  return {
    cases: decoded.cases,
    ...(decoded.nextCursor === undefined ? {} : { nextCursor: decoded.nextCursor }),
  };
};

export function encodeCaseSearchResponse(response: CaseSearchResponse): Record<string, unknown> {
  return {
    cases: response.cases.map(encodeCaseSummary),
    ...(response.nextCursor === undefined ? {} : { nextCursor: response.nextCursor }),
  };
}

/** Bounded grant row shown on the case detail page (never the secret). */
export interface CaseGrantSummary {
  readonly grantId: string;
  readonly state: GrantState;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly maxBytes: bigint;
}

function decodeCaseGrantSummaryField(value: unknown, path: string): bigint {
  return canonicalDecimal({ label: "maxBytes" })(value, path);
}

export const decodeCaseGrantSummary: Decoder<CaseGrantSummary> = (value, path) => {
  const decoded = object(
    {
      grantId: field(identifierField("grantId")),
      state: field(grantStateDecoder),
      createdAt: field(canonicalTimestamp("createdAt")),
      expiresAt: field(canonicalTimestamp("expiresAt")),
      maxBytes: field(decodeCaseGrantSummaryField),
    },
    "case grant summary",
  )(value, path);
  return {
    grantId: decoded.grantId,
    state: decoded.state,
    createdAt: decoded.createdAt,
    expiresAt: decoded.expiresAt,
    maxBytes: decoded.maxBytes,
  };
};

export function encodeCaseGrantSummary(summary: CaseGrantSummary): Record<string, unknown> {
  return {
    grantId: summary.grantId,
    state: summary.state,
    createdAt: summary.createdAt,
    expiresAt: summary.expiresAt,
    maxBytes: summary.maxBytes.toString(),
  };
}

/** Bounded dump row shown on the case detail page. */
export interface CaseDumpSummary {
  readonly dumpId: string;
  readonly phase: DumpPhase;
  readonly originalName: string;
  readonly byteSize: bigint | null;
  readonly receivedAt: string;
}

export const decodeCaseDumpSummary: Decoder<CaseDumpSummary> = (value, path) => {
  const decoded = object(
    {
      dumpId: field(identifierField("dumpId")),
      phase: field(dumpPhaseDecoder),
      originalName: field(text({ max: 1024, label: "originalName" })),
      byteSize: field(nullableField(canonicalDecimal({ label: "byteSize" }))),
      receivedAt: field(canonicalTimestamp("receivedAt")),
    },
    "case dump summary",
  )(value, path);
  return {
    dumpId: decoded.dumpId,
    phase: decoded.phase,
    originalName: decoded.originalName,
    byteSize: decoded.byteSize,
    receivedAt: decoded.receivedAt,
  };
};

export function encodeCaseDumpSummary(summary: CaseDumpSummary): Record<string, unknown> {
  return {
    dumpId: summary.dumpId,
    phase: summary.phase,
    originalName: summary.originalName,
    byteSize: summary.byteSize === null ? null : summary.byteSize.toString(),
    receivedAt: summary.receivedAt,
  };
}

export interface CaseCustomer {
  readonly customerId: string;
  readonly displayName: string;
}

export interface CaseDetailResponse {
  readonly caseId: string;
  readonly customerId: string;
  readonly title: string;
  readonly status: CaseStatus;
  readonly createdAt: string;
  readonly customer: CaseCustomer;
  /** Guidance for presentation only; the engine re-checks every transition. */
  readonly allowedActions: readonly CaseAction[];
  readonly grants: readonly CaseGrantSummary[];
  readonly dumps: readonly CaseDumpSummary[];
  readonly activity: readonly ActivityItem[];
}

export const decodeCaseDetailResponse: Decoder<CaseDetailResponse> = (value, path) => {
  const decoded = object(
    {
      caseId: field(identifierField("caseId")),
      customerId: field(identifierField("customerId")),
      title: field(text({ max: MAX_CASE_TITLE_LENGTH, label: "title" })),
      status: field(caseStatusDecoder),
      createdAt: field(canonicalTimestamp("createdAt")),
      customer: field((entry, entryPath) => {
        const customer = object(
          {
            customerId: field(identifierField("customerId")),
            displayName: field(text({ max: 200, label: "displayName" })),
          },
          "customer",
        )(entry, entryPath);
        return { customerId: customer.customerId, displayName: customer.displayName };
      }),
      allowedActions: field(arrayOf(caseActionDecoder, { label: "allowedActions", maxLength: 5 })),
      grants: field(arrayOf(decodeCaseGrantSummary, { label: "grants", maxLength: MAX_CASE_LIST_ITEMS })),
      dumps: field(arrayOf(decodeCaseDumpSummary, { label: "dumps", maxLength: MAX_CASE_LIST_ITEMS })),
      activity: field((entries, entriesPath) => decodeActivityItems(entries, entriesPath)),
    },
    "case detail response",
  )(value, path);
  return {
    caseId: decoded.caseId,
    customerId: decoded.customerId,
    title: decoded.title,
    status: decoded.status,
    createdAt: decoded.createdAt,
    customer: { customerId: decoded.customer.customerId, displayName: decoded.customer.displayName },
    allowedActions: decoded.allowedActions,
    grants: decoded.grants,
    dumps: decoded.dumps,
    activity: decoded.activity,
  };
};

export function encodeCaseDetailResponse(detail: CaseDetailResponse): Record<string, unknown> {
  return {
    caseId: detail.caseId,
    customerId: detail.customerId,
    title: detail.title,
    status: detail.status,
    createdAt: detail.createdAt,
    customer: { customerId: detail.customer.customerId, displayName: detail.customer.displayName },
    allowedActions: detail.allowedActions,
    grants: detail.grants.map(encodeCaseGrantSummary),
    dumps: detail.dumps.map(encodeCaseDumpSummary),
    activity: detail.activity.map(encodeActivityItem),
  };
}

/** `POST /api/v1/cases/:caseId/transitions` body. */
export interface TransitionRequest {
  readonly action: CaseAction;
}

export const decodeTransitionRequest: Decoder<TransitionRequest> = (value, path) => {
  const decoded = object(
    { action: field(caseActionDecoder) },
    "transition request",
  )(value, path);
  return { action: decoded.action };
};

export function encodeTransitionRequest(request: TransitionRequest): Record<string, unknown> {
  return { action: request.action };
}

/** Grants atomically revoked by a `CloseCase` transition. */
export interface RevokedGrantSummary {
  readonly count: number;
  readonly grantIds: readonly string[];
}

export interface TransitionResponse {
  readonly caseId: string;
  /** The action the server applied. */
  readonly action: CaseAction;
  /** Resulting case status after the applied action. */
  readonly status: CaseStatus;
  /** Canonical UTC time the transition was recorded. */
  readonly occurredAt: string;
  /**
   * Present only for `CloseCase`: the number and identifiers of grants
   * atomically revoked by the closure. `count` must equal `grantIds.length`.
   */
  readonly revokedGrants?: RevokedGrantSummary;
}

const revokedGrantSummaryShape = {
  count: field((entry, entryPath) => {
    if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 0) {
      fail(entryPath, "count must be a non-negative safe integer");
    }
    return entry as number;
  }),
  grantIds: field(arrayOf(identifierField("grantId"), { label: "grantIds" })),
} as const;

export const decodeTransitionResponse: Decoder<TransitionResponse> = (value, path) => {
  const decoded = object(
    {
      caseId: field(identifierField("caseId")),
      action: field(caseActionDecoder),
      status: field(caseStatusDecoder),
      occurredAt: field(canonicalTimestamp("occurredAt")),
      revokedGrants: optional((entry, entryPath) => {
        const inner = object(revokedGrantSummaryShape, "revoked grants")(entry, entryPath);
        if (inner.count !== inner.grantIds.length) {
          fail(entryPath, "count must match the number of revoked grant identifiers");
        }
        return { count: inner.count, grantIds: inner.grantIds };
      }),
    },
    "transition response",
  )(value, path);
  if (decoded.revokedGrants === undefined && decoded.action === "CloseCase") {
    fail("$.revokedGrants", "missing required revoked-grant summary for CloseCase");
  }
  if (decoded.revokedGrants !== undefined && decoded.action !== "CloseCase") {
    fail("$.revokedGrants", "revoked-grant summary is only valid for CloseCase");
  }
  return {
    caseId: decoded.caseId,
    action: decoded.action,
    status: decoded.status,
    occurredAt: decoded.occurredAt,
    ...(decoded.revokedGrants === undefined
      ? {}
      : { revokedGrants: { count: decoded.revokedGrants.count, grantIds: decoded.revokedGrants.grantIds } }),
  };
};

export function encodeTransitionResponse(response: TransitionResponse): Record<string, unknown> {
  return {
    caseId: response.caseId,
    action: response.action,
    status: response.status,
    occurredAt: response.occurredAt,
    ...(response.revokedGrants === undefined
      ? {}
      : {
          revokedGrants: {
            count: response.revokedGrants.count,
            grantIds: response.revokedGrants.grantIds,
          },
        }),
  };
}
