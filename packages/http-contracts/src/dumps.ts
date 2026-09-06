/**
 * Dump, retention, and operations contracts (design section 7.7).
 *
 *   GET  /api/v1/dumps/:dumpId          -> DumpDetailResponse
 *   GET  /api/v1/dumps/:dumpId/content   (raw immutable `.dmp` stream; no JSON body)
 *   PUT  /api/v1/dumps/:dumpId/retention <- RetentionRequest -> RetentionResponse
 *
 * Retention accepts a bounded integer number of days. The backend computes the
 * canonical UTC deadline from its own server clock; the browser clock and
 * timezone are never authoritative.
 */

import {
  booleanField,
  canonicalDecimal,
  canonicalTimestamp,
  field,
  identifierField,
  integerField,
  nullableField,
  object,
  sha256Hex,
  text,
  type Decoder,
} from "./decode.js";
import {
  coverageKindDecoder,
  decodeActivityItems,
  dumpPhaseDecoder,
  encodeActivityItem,
  validationStateDecoder,
  type ActivityItem,
  type CoverageKind,
  type DumpPhase,
  type ValidationState,
} from "./vocab.js";

export const MAX_RETENTION_DAYS = 36_500;
export const MAX_INSPECTION_ERROR_LENGTH = 2000;

/** Dump-detail body: lifecycle, coverage, facts, retention, and activity. */
export interface DumpDetailResponse {
  readonly dumpId: string;
  /** Case breadcrumb/context for the dump page. */
  readonly case: { readonly caseId: string; readonly title: string };
  readonly phase: DumpPhase;
  readonly originalName: string;
  readonly byteSize: bigint | null;
  readonly sha256: string | null;
  readonly validation: ValidationState;
  readonly coverage: CoverageKind | null;
  readonly downloadable: boolean;
  readonly receivedAt: string;
  readonly availableAt: string | null;
  readonly purgeAt: string | null;
  readonly purgedAt: string | null;
  readonly inspectionError: string | null;
  readonly activity: readonly ActivityItem[];
}

export const decodeDumpDetailResponse: Decoder<DumpDetailResponse> = (value, path) => {
  const decoded = object(
    {
      dumpId: field(identifierField("dumpId")),
      case: field((entry, entryPath) => {
        const caseRef = object(
          {
            caseId: field(identifierField("caseId")),
            title: field(text({ max: 300, label: "case title" })),
          },
          "case reference",
        )(entry, entryPath);
        return { caseId: caseRef.caseId, title: caseRef.title };
      }),
      phase: field(dumpPhaseDecoder),
      originalName: field(text({ max: 1024, label: "originalName" })),
      byteSize: field(nullableField(canonicalDecimal({ label: "byteSize" }))),
      sha256: field(nullableField(sha256Hex("sha256"))),
      validation: field(validationStateDecoder),
      coverage: field(nullableField(coverageKindDecoder)),
      downloadable: field(booleanField()),
      receivedAt: field(canonicalTimestamp("receivedAt")),
      availableAt: field(nullableField(canonicalTimestamp("availableAt"))),
      purgeAt: field(nullableField(canonicalTimestamp("purgeAt"))),
      purgedAt: field(nullableField(canonicalTimestamp("purgedAt"))),
      inspectionError: field(
        nullableField(text({ max: MAX_INSPECTION_ERROR_LENGTH, label: "inspectionError" })),
      ),
      activity: field((entries, entriesPath) => decodeActivityItems(entries, entriesPath)),
    },
    "dump detail response",
  )(value, path);
  return {
    dumpId: decoded.dumpId,
    case: { caseId: decoded.case.caseId, title: decoded.case.title },
    phase: decoded.phase,
    originalName: decoded.originalName,
    byteSize: decoded.byteSize,
    sha256: decoded.sha256,
    validation: decoded.validation,
    coverage: decoded.coverage,
    downloadable: decoded.downloadable,
    receivedAt: decoded.receivedAt,
    availableAt: decoded.availableAt,
    purgeAt: decoded.purgeAt,
    purgedAt: decoded.purgedAt,
    inspectionError: decoded.inspectionError,
    activity: decoded.activity,
  };
};

export function encodeDumpDetailResponse(detail: DumpDetailResponse): Record<string, unknown> {
  return {
    dumpId: detail.dumpId,
    case: { caseId: detail.case.caseId, title: detail.case.title },
    phase: detail.phase,
    originalName: detail.originalName,
    byteSize: detail.byteSize === null ? null : detail.byteSize.toString(),
    sha256: detail.sha256,
    validation: detail.validation,
    coverage: detail.coverage,
    downloadable: detail.downloadable,
    receivedAt: detail.receivedAt,
    availableAt: detail.availableAt,
    purgeAt: detail.purgeAt,
    purgedAt: detail.purgedAt,
    inspectionError: detail.inspectionError,
    activity: detail.activity.map(encodeActivityItem),
  };
}

/** `PUT /api/v1/dumps/:dumpId/retention` body: bounded whole days. */
export interface RetentionRequest {
  readonly days: number;
}

export const decodeRetentionRequest: Decoder<RetentionRequest> = (value, path) => {
  const decoded = object(
    { days: field(integerField({ min: 1, max: MAX_RETENTION_DAYS, label: "days" })) },
    "retention request",
  )(value, path);
  return { days: decoded.days };
};

export function encodeRetentionRequest(request: RetentionRequest): Record<string, unknown> {
  return { days: request.days };
}

/** Resulting purge deadline computed from the server clock. */
export interface RetentionResponse {
  readonly dump: { readonly dumpId: string; readonly purgeAt: string };
}

export const decodeRetentionResponse: Decoder<RetentionResponse> = (value, path) => {
  const decoded = object(
    {
      dump: field((entry, entryPath) => {
        const dump = object(
          {
            dumpId: field(identifierField("dumpId")),
            purgeAt: field(canonicalTimestamp("purgeAt")),
          },
          "retained dump",
        )(entry, entryPath);
        return { dumpId: dump.dumpId, purgeAt: dump.purgeAt };
      }),
    },
    "retention response",
  )(value, path);
  return { dump: { dumpId: decoded.dump.dumpId, purgeAt: decoded.dump.purgeAt } };
};

export function encodeRetentionResponse(response: RetentionResponse): Record<string, unknown> {
  return { dump: { dumpId: response.dump.dumpId, purgeAt: response.dump.purgeAt } };
}
