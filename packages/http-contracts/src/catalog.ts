/**
 * Dump catalog contracts (analyzer-integration design: "Dump catalog search"
 * and "Contracts, limits, and errors"; milestone AI1).
 *
 *   GET /api/v1/dumps -> DumpCatalogResponse
 *
 * `decodeDumpCatalogParams` decodes the catalog query bag: every parameter is
 * optional, each may appear at most once, and unknown parameters are rejected
 * like every other shared decoder. The route pages by keyset
 * `(receivedAt, dumpId)` ascending, so `cursor` is opaque and a page ends when
 * `nextCursor` is absent.
 *
 * Rows reuse the ledger's wire conventions: canonical UTC timestamps, decimal
 * strings for byte sizes and addresses, lowercase-hex digests. Inspector facts
 * (`architecture`, `exceptionCode`, `exceptionAddress`) are present only when
 * the stored inspection succeeded; a dump whose `inspectionError` is set
 * simply omits them. `symbolCoverage` carries aggregate counts so an analyzer
 * can pre-flight symbolication without fetching per-dump detail.
 */

import {
  arrayOf,
  canonicalDecimal,
  canonicalTimestamp,
  childPath,
  counterField,
  fail,
  field,
  identifierField,
  integerField,
  nullableField,
  object,
  optional,
  sha256Hex,
  text,
  type Decoder,
} from "./decode.js";
import {
  dumpPhaseDecoder,
  validationStateDecoder,
  type DumpPhase,
  type ValidationState,
} from "./vocab.js";

/** Most dumps one catalog page may carry (server page cap). */
export const MAX_CATALOG_PAGE = 200;

/** Longest accepted catalog cursor (opaque non-whitespace token). */
export const MAX_CATALOG_CURSOR_LENGTH = 256;

/** Longest accepted inspector architecture string. */
export const MAX_CATALOG_ARCHITECTURE_LENGTH = 64;

/**
 * Hard ceiling for one decoded `dumps` array, bounded at 4096 like the
 * existing detail responses (design "Contracts, limits, and errors"); the
 * operational page cap is {@link MAX_CATALOG_PAGE}.
 */
const MAX_CATALOG_RESPONSE_ITEMS = 4096;

/** Highest unsigned 32-bit exception code (`0xFFFFFFFF`). */
const MAX_EXCEPTION_CODE = 4_294_967_295;

/** Canonical non-negative integer text (no sign, leading zeros, or fraction). */
const CANONICAL_UINT_PATTERN = /^(0|[1-9][0-9]*)$/;

/** `GET /api/v1/dumps` query parameters, decoded from URLSearchParams. */
export interface DumpCatalogParams {
  readonly caseId?: string;
  readonly customerId?: string;
  readonly phase?: DumpPhase;
  readonly validation?: ValidationState;
  readonly receivedAfter?: string;
  readonly receivedBefore?: string;
  /** Exact inspector architecture string (`≤ 64` characters). */
  readonly architecture?: string;
  /** Exact unsigned 32-bit exception code, within the JSON number range. */
  readonly exceptionCode?: number;
  readonly sha256?: string;
  /** Opaque keyset cursor (`≤ 256` non-whitespace characters). */
  readonly cursor?: string;
}

const CATALOG_PARAM_KEYS: readonly string[] = [
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
];

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

/** Canonical decimal text within the unsigned 32-bit range. */
const decodeExceptionCodeParam: Decoder<number> = (value, path) => {
  const decoded = text({ max: 10, label: "exceptionCode", pattern: CANONICAL_UINT_PATTERN })(value, path);
  const code = Number(decoded);
  if (code > MAX_EXCEPTION_CODE) fail(path, "exceptionCode exceeds the unsigned 32-bit range");
  return code;
};

export function decodeDumpCatalogParams(
  params: Readonly<Record<string, string | readonly string[] | undefined>>,
): DumpCatalogParams {
  for (const key of Object.keys(params)) {
    if (!CATALOG_PARAM_KEYS.includes(key)) fail(childPath("$", key), "unexpected query parameter");
  }
  const caseId = decodeQueryParam(params, "caseId", identifierField("caseId"));
  const customerId = decodeQueryParam(params, "customerId", identifierField("customerId"));
  const phase = decodeQueryParam(params, "phase", dumpPhaseDecoder);
  const validation = decodeQueryParam(params, "validation", validationStateDecoder);
  const receivedAfter = decodeQueryParam(params, "receivedAfter", canonicalTimestamp("receivedAfter"));
  const receivedBefore = decodeQueryParam(params, "receivedBefore", canonicalTimestamp("receivedBefore"));
  const architecture = decodeQueryParam(
    params,
    "architecture",
    text({ max: MAX_CATALOG_ARCHITECTURE_LENGTH, label: "architecture" }),
  );
  const exceptionCode = decodeQueryParam(params, "exceptionCode", decodeExceptionCodeParam);
  const sha256 = decodeQueryParam(params, "sha256", sha256Hex("sha256"));
  const cursor = decodeQueryParam(
    params,
    "cursor",
    text({ max: MAX_CATALOG_CURSOR_LENGTH, label: "cursor", pattern: /^\S+$/ }),
  );
  return {
    ...(caseId === undefined ? {} : { caseId }),
    ...(customerId === undefined ? {} : { customerId }),
    ...(phase === undefined ? {} : { phase }),
    ...(validation === undefined ? {} : { validation }),
    ...(receivedAfter === undefined ? {} : { receivedAfter }),
    ...(receivedBefore === undefined ? {} : { receivedBefore }),
    ...(architecture === undefined ? {} : { architecture }),
    ...(exceptionCode === undefined ? {} : { exceptionCode }),
    ...(sha256 === undefined ? {} : { sha256 }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

/** Aggregate symbol-store coverage counts for one catalog row. */
export interface DumpCatalogSymbolCoverage {
  /** Module facts with a matching artifact in the symbol store. */
  readonly present: number;
  /** Module facts with a debug identity and no artifact. */
  readonly missing: number;
  /** Module facts without a usable debug identity. */
  readonly unidentified: number;
}

const symbolCoverageShape = {
  present: field(counterField("symbolCoverage.present")),
  missing: field(counterField("symbolCoverage.missing")),
  unidentified: field(counterField("symbolCoverage.unidentified")),
} as const;

const decodeSymbolCoverage: Decoder<DumpCatalogSymbolCoverage> = (value, path) => {
  const decoded = object(symbolCoverageShape, "symbol coverage")(value, path);
  return { present: decoded.present, missing: decoded.missing, unidentified: decoded.unidentified };
};

function encodeSymbolCoverage(coverage: DumpCatalogSymbolCoverage): Record<string, unknown> {
  return { present: coverage.present, missing: coverage.missing, unidentified: coverage.unidentified };
}

/** One bounded dump row of a catalog page (`GET /api/v1/dumps`). */
export interface DumpCatalogEntry {
  readonly dumpId: string;
  readonly caseId: string;
  readonly customerId: string;
  readonly phase: DumpPhase;
  readonly validation: ValidationState;
  readonly originalName: string;
  /** Canonical decimal string on the wire; null until the upload is sealed. */
  readonly byteSize: bigint | null;
  /** Lowercase hex on the wire; null until the upload is sealed. */
  readonly sha256: string | null;
  readonly receivedAt: string;
  readonly availableAt: string | null;
  readonly purgeAt: string | null;
  /** Inspector fact, present only when the stored inspection succeeded. */
  readonly architecture?: string;
  /** Inspector fact: uint32 as a JSON number, present when the inspection carried one. */
  readonly exceptionCode?: number;
  /** Inspector fact: uint64 as a canonical decimal string on the wire. */
  readonly exceptionAddress?: bigint;
  readonly symbolCoverage: DumpCatalogSymbolCoverage;
}

const dumpCatalogEntryShape = {
  dumpId: field(identifierField("dumpId")),
  caseId: field(identifierField("caseId")),
  customerId: field(identifierField("customerId")),
  phase: field(dumpPhaseDecoder),
  validation: field(validationStateDecoder),
  originalName: field(text({ max: 1024, label: "originalName" })),
  byteSize: field(nullableField(canonicalDecimal({ label: "byteSize" }))),
  sha256: field(nullableField(sha256Hex("sha256"))),
  receivedAt: field(canonicalTimestamp("receivedAt")),
  availableAt: field(nullableField(canonicalTimestamp("availableAt"))),
  purgeAt: field(nullableField(canonicalTimestamp("purgeAt"))),
  architecture: optional(text({ max: MAX_CATALOG_ARCHITECTURE_LENGTH, label: "architecture" })),
  exceptionCode: optional(integerField({ min: 0, max: MAX_EXCEPTION_CODE, label: "exceptionCode" })),
  exceptionAddress: optional(canonicalDecimal({ label: "exceptionAddress" })),
  symbolCoverage: field(decodeSymbolCoverage),
} as const;

export const decodeDumpCatalogEntry: Decoder<DumpCatalogEntry> = (value, path) => {
  const decoded = object(dumpCatalogEntryShape, "dump catalog entry")(value, path);
  return {
    dumpId: decoded.dumpId,
    caseId: decoded.caseId,
    customerId: decoded.customerId,
    phase: decoded.phase,
    validation: decoded.validation,
    originalName: decoded.originalName,
    byteSize: decoded.byteSize,
    sha256: decoded.sha256,
    receivedAt: decoded.receivedAt,
    availableAt: decoded.availableAt,
    purgeAt: decoded.purgeAt,
    ...(decoded.architecture === undefined ? {} : { architecture: decoded.architecture }),
    ...(decoded.exceptionCode === undefined ? {} : { exceptionCode: decoded.exceptionCode }),
    ...(decoded.exceptionAddress === undefined ? {} : { exceptionAddress: decoded.exceptionAddress }),
    symbolCoverage: decoded.symbolCoverage,
  };
};

export function encodeDumpCatalogEntry(entry: DumpCatalogEntry): Record<string, unknown> {
  return {
    dumpId: entry.dumpId,
    caseId: entry.caseId,
    customerId: entry.customerId,
    phase: entry.phase,
    validation: entry.validation,
    originalName: entry.originalName,
    byteSize: entry.byteSize === null ? null : entry.byteSize.toString(),
    sha256: entry.sha256,
    receivedAt: entry.receivedAt,
    availableAt: entry.availableAt,
    purgeAt: entry.purgeAt,
    ...(entry.architecture === undefined ? {} : { architecture: entry.architecture }),
    ...(entry.exceptionCode === undefined ? {} : { exceptionCode: entry.exceptionCode }),
    ...(entry.exceptionAddress === undefined ? {} : { exceptionAddress: entry.exceptionAddress.toString() }),
    symbolCoverage: encodeSymbolCoverage(entry.symbolCoverage),
  };
}

/** `GET /api/v1/dumps` body: one keyset-ordered page of dump rows. */
export interface DumpCatalogResponse {
  readonly dumps: readonly DumpCatalogEntry[];
  /** Opaque keyset cursor for the next page; absent on the final page. */
  readonly nextCursor?: string;
}

export const decodeDumpCatalogResponse: Decoder<DumpCatalogResponse> = (value, path) => {
  const decoded = object(
    {
      dumps: field(arrayOf(decodeDumpCatalogEntry, { label: "dumps", maxLength: MAX_CATALOG_RESPONSE_ITEMS })),
      nextCursor: optional(text({ max: MAX_CATALOG_CURSOR_LENGTH, label: "nextCursor", pattern: /^\S+$/ })),
    },
    "dump catalog response",
  )(value, path);
  return {
    dumps: decoded.dumps,
    ...(decoded.nextCursor === undefined ? {} : { nextCursor: decoded.nextCursor }),
  };
};

export function encodeDumpCatalogResponse(response: DumpCatalogResponse): Record<string, unknown> {
  return {
    dumps: response.dumps.map(encodeDumpCatalogEntry),
    ...(response.nextCursor === undefined ? {} : { nextCursor: response.nextCursor }),
  };
}
