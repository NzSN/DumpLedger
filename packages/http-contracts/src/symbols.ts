/**
 * Symbol-artifact contracts (symbols design: "Ingest (operator surface)",
 * "Security model", resolved decisions D1–D4).
 *
 *   POST   /api/v1/symbols              raw `application/octet-stream` bytes
 *                                       X-Symbol-Filename-Base64url: <UTF-8 filename>
 *                                       -> SymbolIngestResponse
 *   GET    /api/v1/symbols              -> SymbolListResponse
 *   DELETE /api/v1/symbols/:artifactId  purge (relative path via symbolPathForArtifact)
 *
 * Raw-stream convention like dump upload: no multipart, no base64 body, and the
 * server — never the uploader — derives the artifact identity from the bytes
 * (PDB RSDS GUID+age; decision D2 keeps v1 PDB-only). The client-supplied
 * filename is a display-only annotation bounded like dump filenames, so the
 * base64url header helpers are reused from `uploads.js` instead of being
 * duplicated here. Re-ingesting a known identity is an UPSERT-no-op: the
 * response names the original `artifactId` and sets `deduplicated`.
 */

import {
  arrayOf,
  booleanField,
  canonicalDecimal,
  canonicalTimestamp,
  field,
  identifierField,
  object,
  oneOf,
  optional,
  sha256Hex,
  text,
  type Decoder,
} from "./decode.js";
import { decodeFilenameBase64url, encodeFilenameBase64url, MAX_UPLOAD_FILENAME_LENGTH } from "./uploads.js";

/** Ingest header carrying the display-only original filename (UTF-8, base64url). */
export const X_SYMBOL_FILENAME_HEADER = "x-symbol-filename-base64url";

/**
 * Operator ingest/list surface. `POST` and `GET` target this path directly;
 * purge is `DELETE /api/v1/symbols/<artifactId>`.
 */
export const SYMBOLS_PATH = "/api/v1/symbols";

/** Symbol filenames are display-only and bounded like dump filenames. */
export const MAX_SYMBOL_FILENAME_LENGTH = MAX_UPLOAD_FILENAME_LENGTH;

/** Per-artifact byte ceiling enforced mid-stream (decision D3: 8 GiB). */
export const MAX_SYMBOL_BYTES = 8_589_934_592n;

/** Longest product/version/arch annotation accepted for browsing and filtering. */
export const MAX_SYMBOL_ANNOTATION_LENGTH = 200;

/** Most artifacts one list response may carry (bounded like the other list contracts). */
export const MAX_SYMBOL_LIST_ITEMS = 200;

/** v1 ingests PDBs only (decision D2); the EXE kind rides the same entity later. */
export const SYMBOL_KINDS = ["pdb"] as const;
export type SymbolKind = (typeof SYMBOL_KINDS)[number];

/** Encodes a display-only symbol filename for {@link X_SYMBOL_FILENAME_HEADER}. */
export function encodeSymbolFilenameBase64url(filename: string): string {
  return encodeFilenameBase64url(filename);
}

/**
 * Decodes and validates the `X-Symbol-Filename-Base64url` header value with
 * the dump filename rules (bounded header, valid UTF-8, separator-free and
 * control-character-free filename); malformed input falls back on the backend.
 */
export function decodeSymbolFilenameBase64url(headerValue: unknown, path = "$.x-symbol-filename-base64url"): string {
  return decodeFilenameBase64url(headerValue, path);
}

/** Relative purge path for one artifact: `DELETE /api/v1/symbols/<artifactId>`. */
export function symbolPathForArtifact(artifactId: string): string {
  return `${SYMBOLS_PATH}/${artifactId}`;
}

/**
 * 201 body for `POST /api/v1/symbols`: the identity parsed from the bytes.
 * `deduplicated` is true when the identity already existed, in which case
 * `artifactId` names the original artifact (re-ingest is idempotent).
 */
export interface SymbolIngestResponse {
  readonly artifactId: string;
  readonly debugFile: string;
  readonly debugId: string;
  readonly kind: SymbolKind;
  readonly byteSize: bigint;
  readonly sha256: string;
  readonly deduplicated: boolean;
}

export const decodeSymbolIngestResponse: Decoder<SymbolIngestResponse> = (value, path) => {
  const decoded = object(
    {
      artifactId: field(identifierField("artifactId")),
      debugFile: field(identifierField("debugFile")),
      debugId: field(identifierField("debugId")),
      kind: field(oneOf(SYMBOL_KINDS, "symbol kind")),
      byteSize: field(canonicalDecimal({ label: "byteSize" })),
      sha256: field(sha256Hex("sha256")),
      deduplicated: field(booleanField()),
    },
    "symbol ingest response",
  )(value, path);
  return {
    artifactId: decoded.artifactId,
    debugFile: decoded.debugFile,
    debugId: decoded.debugId,
    kind: decoded.kind,
    byteSize: decoded.byteSize,
    sha256: decoded.sha256,
    deduplicated: decoded.deduplicated,
  };
};

export function encodeSymbolIngestResponse(response: SymbolIngestResponse): Record<string, unknown> {
  return {
    artifactId: response.artifactId,
    debugFile: response.debugFile,
    debugId: response.debugId,
    kind: response.kind,
    byteSize: response.byteSize.toString(),
    sha256: response.sha256,
    deduplicated: response.deduplicated,
  };
}

/**
 * One stored symbol artifact as listed on the operator Symbols page. The
 * debug identity is authoritative; `product`, `version`, and `arch` are
 * uploader annotations for browsing and filtering and never participate in
 * resolution, so they stay optional.
 */
export interface SymbolRecord {
  readonly artifactId: string;
  readonly debugFile: string;
  readonly debugId: string;
  readonly kind: SymbolKind;
  readonly byteSize: bigint;
  readonly sha256: string;
  readonly product?: string;
  readonly version?: string;
  readonly arch?: string;
  readonly ingestedAt: string;
}

export const decodeSymbolRecord: Decoder<SymbolRecord> = (value, path) => {
  const decoded = object(
    {
      artifactId: field(identifierField("artifactId")),
      debugFile: field(identifierField("debugFile")),
      debugId: field(identifierField("debugId")),
      kind: field(oneOf(SYMBOL_KINDS, "symbol kind")),
      byteSize: field(canonicalDecimal({ label: "byteSize" })),
      sha256: field(sha256Hex("sha256")),
      product: optional(text({ max: MAX_SYMBOL_ANNOTATION_LENGTH, label: "product" })),
      version: optional(text({ max: MAX_SYMBOL_ANNOTATION_LENGTH, label: "version" })),
      arch: optional(text({ max: MAX_SYMBOL_ANNOTATION_LENGTH, label: "arch" })),
      ingestedAt: field(canonicalTimestamp("ingestedAt")),
    },
    "symbol record",
  )(value, path);
  return {
    artifactId: decoded.artifactId,
    debugFile: decoded.debugFile,
    debugId: decoded.debugId,
    kind: decoded.kind,
    byteSize: decoded.byteSize,
    sha256: decoded.sha256,
    ...(decoded.product === undefined ? {} : { product: decoded.product }),
    ...(decoded.version === undefined ? {} : { version: decoded.version }),
    ...(decoded.arch === undefined ? {} : { arch: decoded.arch }),
    ingestedAt: decoded.ingestedAt,
  };
};

export function encodeSymbolRecord(record: SymbolRecord): Record<string, unknown> {
  return {
    artifactId: record.artifactId,
    debugFile: record.debugFile,
    debugId: record.debugId,
    kind: record.kind,
    byteSize: record.byteSize.toString(),
    sha256: record.sha256,
    ...(record.product === undefined ? {} : { product: record.product }),
    ...(record.version === undefined ? {} : { version: record.version }),
    ...(record.arch === undefined ? {} : { arch: record.arch }),
    ingestedAt: record.ingestedAt,
  };
}

/** `GET /api/v1/symbols` body: the artifact list without byte contents. */
export interface SymbolListResponse {
  readonly symbols: readonly SymbolRecord[];
}

export const decodeSymbolListResponse: Decoder<SymbolListResponse> = (value, path) => {
  const decoded = object(
    {
      symbols: field(arrayOf(decodeSymbolRecord, { label: "symbols", maxLength: MAX_SYMBOL_LIST_ITEMS })),
    },
    "symbol list response",
  )(value, path);
  return { symbols: decoded.symbols };
};

export function encodeSymbolListResponse(response: SymbolListResponse): Record<string, unknown> {
  return { symbols: response.symbols.map(encodeSymbolRecord) };
}
