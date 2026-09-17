/**
 * Pure copy and formatting helpers for the Symbols page (no React, no HTTP).
 *
 * Known ingest failures get fixed operator copy — mirroring the backend's
 * stable messages for the symbol error codes — so the queue never renders an
 * envelope's incidental wording; anything unknown surfaces the error text the
 * shared client produced.
 */

import {
  MAX_SYMBOL_BYTES,
  type SymbolIngestResponse,
  type SymbolKind,
} from "@dump-ledger/http-contracts";
import { formatBytes } from "../../shared/format";
import { HttpRequestError, errorText } from "../../shared/http-client";

/**
 * Full debug identity (GUID + age) shortened for row display, e.g.
 * `3A9C…1`; the complete value stays available through the row's title.
 */
export function truncateDebugId(debugId: string): string {
  if (debugId.length <= 6) return debugId;
  return `${debugId.slice(0, 4)}…${debugId.slice(-1)}`;
}

export function symbolKindLabel(kind: SymbolKind): string {
  switch (kind) {
    case "pdb":
      return "PDB";
  }
}

/**
 * One-line identity result for a settled ingest:
 * `electron.pdb 3A9C…1 registered (214 MiB)` — or `already registered` when
 * the identity was already in the store (deduplicated).
 */
export function ingestResultText(response: SymbolIngestResponse): string {
  const verdict = response.deduplicated ? "already registered" : "registered";
  return `${response.debugFile} ${truncateDebugId(response.debugId)} ${verdict} (${formatBytes(response.byteSize)})`;
}

export function ingestFailureText(error: unknown): string {
  const code = error instanceof HttpRequestError ? error.code : undefined;
  switch (code) {
    case "symbol_identity_unreadable":
      return "Not a PDB or no RSDS record.";
    case "symbol_kind_unsupported":
      return "Only PDB files are supported.";
    case "symbol_too_large":
    case "upload_too_large":
      return `Larger than the ${formatBytes(MAX_SYMBOL_BYTES)} symbol artifact ceiling.`;
    default:
      return errorText(error, "The file could not be ingested.");
  }
}
