/**
 * Analysis write-back contracts (analyzer-integration design: "Analysis
 * write-back"; milestone AI3, task G1).
 *
 *   POST /api/v1/dumps/:dumpId/analyses -> AnalysisReport
 *   GET  /api/v1/dumps/:dumpId/analyses -> AnalysisListResponse
 *
 * `RecordAnalysisRequest` is the analyzer-supplied body: a self-reported
 * `analyzer` name/version (attribution hints, not identity), a bounded
 * `kind` (a plain string, deliberately not a contract enum, so new analyzer
 * kinds never require a contract release), the `inputSha256` pinning the
 * verdict to exact dump bytes, `outcome`, a bounded `summary`, an optional
 * bounded `facts` JSON object, and an optional `duplicateOf` association.
 * `AnalysisReport` adds the server-side identity (`analysisId`, `dumpId`,
 * `createdAt` — the server clock is authoritative, never the analyzer's).
 *
 * The entity identity is `(dumpId, analyzer.name, analyzer.version, kind,
 * inputSha256)`: a repeat report with the same identity is an idempotent
 * replay, so the route layer resolves duplicates instead of storing a second
 * row; {@link MAX_ANALYSES_PER_DUMP} bounds reports per dump.
 *
 * The whole request body stays under the server's 16 KiB JSON limit (the
 * shared limit for every write route); `facts` is additionally bounded at
 * {@link MAX_ANALYSIS_FACTS_BYTES} of compact serialized JSON, mirroring the
 * event feed `detail` rule, so one field cannot dominate that budget.
 * Unknown fields, duplicate keys, and wrong types are rejected like every
 * other shared decoder. `facts` is untrusted input, later rendered as text,
 * never markup.
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
  oneOf,
  optional,
  sha256Hex,
  text,
  type Decoder,
} from "./decode.js";

/** Most analysis reports one dump may hold (route-layer cap; milestone AI3). */
export const MAX_ANALYSES_PER_DUMP = 64;

/** Longest accepted analyzer name (`1..128` characters). */
export const MAX_ANALYSIS_NAME_LENGTH = 128;

/** Longest accepted analyzer version (`1..64` characters). */
export const MAX_ANALYSIS_VERSION_LENGTH = 64;

/** Longest accepted analysis kind (`1..64` characters). */
export const MAX_ANALYSIS_KIND_LENGTH = 64;

/** Longest accepted analysis summary (`≤ 2000` characters; empty is allowed). */
export const MAX_ANALYSIS_SUMMARY_LENGTH = 2000;

/** Longest accepted serialized `facts` payload, in compact-JSON UTF-8 bytes. */
export const MAX_ANALYSIS_FACTS_BYTES = 4096;

/**
 * Hard ceiling for one decoded `analyses` array, bounded at 4096 like the
 * existing detail responses (design "Contracts, limits, and errors").
 */
const MAX_ANALYSIS_RESPONSE_ITEMS = 4096;

/** Verdict outcome vocabulary; a closed set, unlike `kind`. */
export const ANALYSIS_OUTCOMES = ["completed", "failed"] as const;
export type AnalysisOutcome = (typeof ANALYSIS_OUTCOMES)[number];

export const analysisOutcomeDecoder: Decoder<AnalysisOutcome> = oneOf(ANALYSIS_OUTCOMES, "outcome");

/** Self-reported analyzer identity; untrusted attribution hints, not credentials. */
export interface AnalysisAnalyzer {
  /** Analyzer name (`1..128` characters). */
  readonly name: string;
  /** Analyzer version (`1..64` characters). */
  readonly version: string;
}

const analyzerShape = {
  name: field(text({ max: MAX_ANALYSIS_NAME_LENGTH, label: "analyzer.name" })),
  version: field(text({ max: MAX_ANALYSIS_VERSION_LENGTH, label: "analyzer.version" })),
} as const;

export const decodeAnalysisAnalyzer: Decoder<AnalysisAnalyzer> = (value, path) => {
  const decoded = object(analyzerShape, "analyzer")(value, path);
  return { name: decoded.name, version: decoded.version };
};

export function encodeAnalysisAnalyzer(analyzer: AnalysisAnalyzer): Record<string, unknown> {
  return { name: analyzer.name, version: analyzer.version };
}

/**
 * Validates that a value is a plain JSON tree: no `undefined`, functions,
 * symbols, bigints, non-finite numbers, or exotic objects. Containers deeper
 * than {@link MAX_JSON_DEPTH} reject so serialization stays total.
 */
function assertJsonValue(value: unknown, path: string, depth: number): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail(path, "facts must contain only finite JSON numbers");
    return;
  }
  if (Array.isArray(value)) {
    if (depth >= MAX_JSON_DEPTH) fail(path, "facts exceeds the maximum nesting depth");
    for (let index = 0; index < value.length; index += 1) {
      assertJsonValue(value[index], childPath(path, index), depth + 1);
    }
    return;
  }
  if (isRecord(value)) {
    if (depth >= MAX_JSON_DEPTH) fail(path, "facts exceeds the maximum nesting depth");
    for (const key of Object.keys(value)) {
      assertJsonValue(value[key], childPath(path, key), depth + 1);
    }
    return;
  }
  fail(path, "facts must contain only JSON values");
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
 * Analysis facts: a JSON object whose compact serialization (`JSON.stringify`
 * with no spacing) fits {@link MAX_ANALYSIS_FACTS_BYTES} UTF-8 bytes. Same
 * rule as the event feed `detail` field (events.ts); that helper is private
 * to its module, so the rule is mirrored here rather than imported.
 */
const decodeAnalysisFacts: Decoder<Readonly<Record<string, unknown>>> = (value, path) => {
  if (!isRecord(value)) fail(path, "facts must be a JSON object");
  assertJsonValue(value, path, 0);
  const serialized = JSON.stringify(value);
  if (utf8ByteLength(serialized) > MAX_ANALYSIS_FACTS_BYTES) {
    fail(path, `facts exceeds ${MAX_ANALYSIS_FACTS_BYTES} serialized bytes`);
  }
  return value;
};

/** Fields shared by the request body and the stored report. */
const analysisFieldsShape = {
  analyzer: field(decodeAnalysisAnalyzer),
  kind: field(text({ max: MAX_ANALYSIS_KIND_LENGTH, label: "kind" })),
  inputSha256: field(sha256Hex("inputSha256")),
  outcome: field(analysisOutcomeDecoder),
  summary: field(text({ min: 0, max: MAX_ANALYSIS_SUMMARY_LENGTH, label: "summary" })),
  facts: optional(decodeAnalysisFacts),
  duplicateOf: optional(nullableField(identifierField("duplicateOf"))),
} as const;

/**
 * `POST /api/v1/dumps/:dumpId/analyses` body: one analyzer verdict about the
 * dump in the route path. The route layer must reject when `inputSha256`
 * differs from the dump's current sealed hash (design "Analysis write-back").
 */
export interface RecordAnalysisRequest {
  readonly analyzer: AnalysisAnalyzer;
  /** Bounded string, not an enum: new analyzer kinds need no contract release. */
  readonly kind: string;
  /** Lowercase hex sha256 of the exact dump bytes the verdict covers. */
  readonly inputSha256: string;
  readonly outcome: AnalysisOutcome;
  /** Human-readable summary (`≤ 2000` characters; may be empty). */
  readonly summary: string;
  /** Bounded JSON object (`≤ 4096` serialized UTF-8 bytes); opaque to the wire. */
  readonly facts?: Readonly<Record<string, unknown>>;
  /** Dump this verdict duplicates, when the analyzer recognized one. */
  readonly duplicateOf?: string | null;
}

const recordAnalysisRequestShape = analysisFieldsShape;

export const decodeRecordAnalysisRequest: Decoder<RecordAnalysisRequest> = (value, path) => {
  const decoded = object(recordAnalysisRequestShape, "record analysis request")(value, path);
  return {
    analyzer: decoded.analyzer,
    kind: decoded.kind,
    inputSha256: decoded.inputSha256,
    outcome: decoded.outcome,
    summary: decoded.summary,
    ...(decoded.facts === undefined ? {} : { facts: decoded.facts }),
    ...(decoded.duplicateOf === undefined ? {} : { duplicateOf: decoded.duplicateOf }),
  };
};

/** Symmetric encoder for {@link decodeRecordAnalysisRequest}. */
export function encodeRecordAnalysisRequest(request: RecordAnalysisRequest): Record<string, unknown> {
  return {
    analyzer: encodeAnalysisAnalyzer(request.analyzer),
    kind: request.kind,
    inputSha256: request.inputSha256,
    outcome: request.outcome,
    summary: request.summary,
    ...(request.facts === undefined ? {} : { facts: request.facts }),
    ...(request.duplicateOf === undefined ? {} : { duplicateOf: request.duplicateOf }),
  };
}

/** One stored analysis report: the request fields plus server-side identity. */
export interface AnalysisReport extends RecordAnalysisRequest {
  readonly analysisId: string;
  readonly dumpId: string;
  /** Server clock (`createdAt`), canonical UTC ISO; never analyzer-supplied. */
  readonly createdAt: string;
}

const analysisReportShape = {
  analysisId: field(identifierField("analysisId")),
  dumpId: field(identifierField("dumpId")),
  ...analysisFieldsShape,
  createdAt: field(canonicalTimestamp("createdAt")),
} as const;

export const decodeAnalysisReport: Decoder<AnalysisReport> = (value, path) => {
  const decoded = object(analysisReportShape, "analysis report")(value, path);
  return {
    analysisId: decoded.analysisId,
    dumpId: decoded.dumpId,
    analyzer: decoded.analyzer,
    kind: decoded.kind,
    inputSha256: decoded.inputSha256,
    outcome: decoded.outcome,
    summary: decoded.summary,
    createdAt: decoded.createdAt,
    ...(decoded.facts === undefined ? {} : { facts: decoded.facts }),
    ...(decoded.duplicateOf === undefined ? {} : { duplicateOf: decoded.duplicateOf }),
  };
};

/** Symmetric encoder for {@link decodeAnalysisReport}. */
export function encodeAnalysisReport(report: AnalysisReport): Record<string, unknown> {
  return {
    analysisId: report.analysisId,
    dumpId: report.dumpId,
    ...encodeRecordAnalysisRequest(report),
    createdAt: report.createdAt,
  };
}

/** `GET /api/v1/dumps/:dumpId/analyses` body: every report for one dump. */
export interface AnalysisListResponse {
  readonly analyses: readonly AnalysisReport[];
}

export const decodeAnalysisListResponse: Decoder<AnalysisListResponse> = (value, path) => {
  const decoded = object(
    {
      analyses: field(
        arrayOf(decodeAnalysisReport, { label: "analyses", maxLength: MAX_ANALYSIS_RESPONSE_ITEMS }),
      ),
    },
    "analysis list response",
  )(value, path);
  return { analyses: decoded.analyses };
};

/** Symmetric encoder for {@link decodeAnalysisListResponse}. */
export function encodeAnalysisListResponse(response: AnalysisListResponse): Record<string, unknown> {
  return { analyses: response.analyses.map(encodeAnalysisReport) };
}
