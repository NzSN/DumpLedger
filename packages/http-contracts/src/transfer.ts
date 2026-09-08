/**
 * Transfer contracts (import/export design, "HTTP and UI surface"): operator
 * export bundles and verified bundle imports.
 *
 *   POST   /api/v1/operations/exports           -> CreateExportResponse
 *   GET    /api/v1/operations/exports           -> ListExportsResponse
 *   GET    /api/v1/operations/exports/:id/file  (raw streamed tar download:
 *                                                no JSON body, so no contract here)
 *   DELETE /api/v1/operations/exports/:id       -> DeleteExportResponse
 *   POST   /api/v1/operations/imports           <- CreateImportRequest
 *                                               -> CreateImportResponse
 *   GET    /api/v1/operations/imports/:id       -> ImportProgressResponse
 *
 * Bundle bytes never cross this interface as JSON: the export download
 * streams the tar directly, and import references a server-local bundle
 * path, so a multi-GB bundle never transits the browser.
 */

import {
  MAX_CANONICAL_DECIMAL_DIGITS,
  arrayOf,
  booleanField,
  canonicalTimestamp,
  childPath,
  counterField,
  fail,
  field,
  identifierField,
  nullableField,
  object,
  oneOf,
  text,
  type Decoder,
} from "./decode.js";

/** Highest accepted number of entries in the operations export list. */
export const MAX_EXPORT_LIST_ITEMS = 200;

/** Highest accepted length of a server-local import bundle path. */
export const MAX_IMPORT_PATH_LENGTH = 1024;

/** Highest accepted length of an operator-facing transfer failure detail. */
export const MAX_TRANSFER_ERROR_LENGTH = 2000;

export const EXPORT_STATUSES = ["running", "sealed", "failed"] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];

export const IMPORT_STATUSES = ["running", "finished", "failed"] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

export const exportStatusDecoder: Decoder<ExportStatus> = oneOf(EXPORT_STATUSES, "export status");
export const importStatusDecoder: Decoder<ImportStatus> = oneOf(IMPORT_STATUSES, "import status");

const BYTE_SIZE_PATTERN = /^(0|[1-9][0-9]*)$/;

/**
 * Bundle byte size on the wire: a canonical decimal string (no sign, leading
 * zeros, fraction, or exponent), or null while the bundle is not sealed.
 * Unlike dump byte sizes it stays a string; the operations page displays it
 * verbatim and never does arithmetic on it.
 */
const byteSizeField: Decoder<string> = text({
  max: MAX_CANONICAL_DECIMAL_DIGITS,
  label: "byteSize",
  pattern: BYTE_SIZE_PATTERN,
});

/** `POST /api/v1/operations/exports` success body. */
export interface CreateExportResponse {
  readonly exportId: string;
}

export const decodeCreateExportResponse: Decoder<CreateExportResponse> = (value, path) => {
  const decoded = object(
    { exportId: field(identifierField("exportId")) },
    "create export response",
  )(value, path);
  return { exportId: decoded.exportId };
};

export function encodeCreateExportResponse(response: CreateExportResponse): Record<string, unknown> {
  return { exportId: response.exportId };
}

/** One bounded row of the operations export list. */
export interface ExportSummary {
  readonly exportId: string;
  readonly status: ExportStatus;
  readonly createdAt: string;
  /** Canonical decimal string; null until the bundle is sealed. */
  readonly byteSize: string | null;
  /** Operator-facing failure detail; null unless the export failed. */
  readonly error: string | null;
}

const exportSummaryShape = {
  exportId: field(identifierField("exportId")),
  status: field(exportStatusDecoder),
  createdAt: field(canonicalTimestamp("createdAt")),
  byteSize: field(nullableField(byteSizeField)),
  error: field(nullableField(text({ max: MAX_TRANSFER_ERROR_LENGTH, label: "error" }))),
} as const;

export const decodeExportSummary: Decoder<ExportSummary> = (value, path) => {
  const decoded = object(exportSummaryShape, "export summary")(value, path);
  return {
    exportId: decoded.exportId,
    status: decoded.status,
    createdAt: decoded.createdAt,
    byteSize: decoded.byteSize,
    error: decoded.error,
  };
};

export function encodeExportSummary(summary: ExportSummary): Record<string, unknown> {
  return {
    exportId: summary.exportId,
    status: summary.status,
    createdAt: summary.createdAt,
    byteSize: summary.byteSize,
    error: summary.error,
  };
}

/** `GET /api/v1/operations/exports` body: the bounded export list. */
export interface ListExportsResponse {
  readonly exports: readonly ExportSummary[];
}

export const decodeListExportsResponse: Decoder<ListExportsResponse> = (value, path) => {
  const decoded = object(
    { exports: field(arrayOf(decodeExportSummary, { label: "exports", maxLength: MAX_EXPORT_LIST_ITEMS })) },
    "list exports response",
  )(value, path);
  return { exports: decoded.exports };
};

export function encodeListExportsResponse(response: ListExportsResponse): Record<string, unknown> {
  return { exports: response.exports.map(encodeExportSummary) };
}

/** `DELETE /api/v1/operations/exports/:id` success body. */
export interface DeleteExportResponse {
  readonly deleted: true;
}

export const decodeDeleteExportResponse: Decoder<DeleteExportResponse> = (value, path) => {
  const decoded = object(
    { deleted: field(booleanField()) },
    "delete export response",
  )(value, path);
  if (decoded.deleted !== true) fail(childPath(path, "deleted"), "deleted must be true");
  return { deleted: true };
};

export function encodeDeleteExportResponse(response: DeleteExportResponse): Record<string, unknown> {
  return { deleted: response.deleted };
}

/**
 * `POST /api/v1/operations/imports` body: a server-local export bundle path.
 * The wire contract only bounds the text; the server validates the path
 * against its own filesystem policy before touching the bundle.
 */
export interface CreateImportRequest {
  readonly path: string;
}

export const decodeCreateImportRequest: Decoder<CreateImportRequest> = (value, path) => {
  const decoded = object(
    { path: field(text({ max: MAX_IMPORT_PATH_LENGTH, label: "path" })) },
    "create import request",
  )(value, path);
  return { path: decoded.path };
};

export function encodeCreateImportRequest(request: CreateImportRequest): Record<string, unknown> {
  return { path: request.path };
}

/** `POST /api/v1/operations/imports` success body. */
export interface CreateImportResponse {
  readonly importId: string;
}

export const decodeCreateImportResponse: Decoder<CreateImportResponse> = (value, path) => {
  const decoded = object(
    { importId: field(identifierField("importId")) },
    "create import response",
  )(value, path);
  return { importId: decoded.importId };
};

export function encodeCreateImportResponse(response: CreateImportResponse): Record<string, unknown> {
  return { importId: response.importId };
}

/** `GET /api/v1/operations/imports/:id` body: live import progress counters. */
export interface ImportProgressResponse {
  readonly importId: string;
  readonly status: ImportStatus;
  readonly verified: number;
  readonly imported: number;
  readonly rejected: number;
  readonly skipped: number;
  /** Operator-facing failure detail; null unless the import failed. */
  readonly error: string | null;
}

const importProgressShape = {
  importId: field(identifierField("importId")),
  status: field(importStatusDecoder),
  verified: field(counterField("verified")),
  imported: field(counterField("imported")),
  rejected: field(counterField("rejected")),
  skipped: field(counterField("skipped")),
  error: field(nullableField(text({ max: MAX_TRANSFER_ERROR_LENGTH, label: "error" }))),
} as const;

export const decodeImportProgressResponse: Decoder<ImportProgressResponse> = (value, path) => {
  const decoded = object(importProgressShape, "import progress response")(value, path);
  return {
    importId: decoded.importId,
    status: decoded.status,
    verified: decoded.verified,
    imported: decoded.imported,
    rejected: decoded.rejected,
    skipped: decoded.skipped,
    error: decoded.error,
  };
};

export function encodeImportProgressResponse(response: ImportProgressResponse): Record<string, unknown> {
  return {
    importId: response.importId,
    status: response.status,
    verified: response.verified,
    imported: response.imported,
    rejected: response.rejected,
    skipped: response.skipped,
    error: response.error,
  };
}
