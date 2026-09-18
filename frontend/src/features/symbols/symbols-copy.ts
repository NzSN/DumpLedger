/**
 * Pure copy and formatting helpers for the Symbols feature — the operator
 * store page plus the dump/case linkage lists (no React, no HTTP).
 *
 * Known ingest failures get fixed operator copy — mirroring the backend's
 * stable messages for the symbol error codes — so the queue never renders an
 * envelope's incidental wording; anything unknown surfaces the error text the
 * shared client produced.
 */

import {
  MAX_SYMBOL_BYTES,
  type ModuleSymbolStatus,
  type SymbolIdentityFields,
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
    case "exe":
      return "EXE";
  }
}

/**
 * The identity pair a record or ingest response resolves by, fixed by kind:
 * a PDB carries the debug identity, an EXE/DLL image the code identity. The
 * contract guarantees the applicable pair on the wire; the helpers keep a
 * defensive `null` so a malformed hand-written fixture cannot crash a row.
 */
export function symbolIdentityName(identity: SymbolIdentityFields & { readonly kind: SymbolKind }): string | null {
  return identity.kind === "exe" ? identity.codeFile : identity.debugFile;
}

export function symbolIdentityId(identity: SymbolIdentityFields & { readonly kind: SymbolKind }): string | null {
  return identity.kind === "exe" ? identity.codeId : identity.debugId;
}

/**
 * One-line identity result for a settled ingest:
 * `electron.pdb 3A9C…1 registered (214 MiB)` — or `already registered` when
 * the identity was already in the store (deduplicated).
 */
export function ingestResultText(response: SymbolIngestResponse): string {
  const verdict = response.deduplicated ? "already registered" : "registered";
  const name = symbolIdentityName(response) ?? "symbol file";
  const identity = symbolIdentityId(response);
  return `${name} ${identity === null ? "?" : truncateDebugId(identity)} ${verdict} (${formatBytes(response.byteSize)})`;
}

export function ingestFailureText(error: unknown): string {
  const code = error instanceof HttpRequestError ? error.code : undefined;
  switch (code) {
    case "symbol_identity_unreadable":
      return "No readable PDB or PE identity.";
    case "symbol_kind_unsupported":
      return "Only PDB, EXE, and DLL files are supported.";
    case "symbol_too_large":
    case "upload_too_large":
      return `Larger than the ${formatBytes(MAX_SYMBOL_BYTES)} symbol artifact ceiling.`;
    default:
      return errorText(error, "The file could not be ingested.");
  }
}

/** Display name for a module the inspector could not name. */
export const UNNAMED_MODULE_LABEL = "unnamed module";

export function moduleNameLabel(name: string | null): string {
  return name ?? UNNAMED_MODULE_LABEL;
}

/** Short status word paired with the coverage glyph. */
export function moduleSymbolStatusLabel(status: ModuleSymbolStatus): string {
  switch (status) {
    case "present":
      return "present";
    case "missing":
      return "missing";
    case "unidentified":
      return "no debug identity";
  }
}

/** Coverage glyph; `unidentified` is a dash, not a failure mark. */
export function moduleSymbolStatusGlyph(status: ModuleSymbolStatus): string {
  switch (status) {
    case "present":
      return "✓";
    case "missing":
      return "✗";
    case "unidentified":
      return "—";
  }
}

/** Case-page aggregation line, e.g. `Referenced by 2 dumps`. */
export function referencingDumpCountLabel(count: number): string {
  return count === 1 ? "Referenced by 1 dump" : `Referenced by ${count} dumps`;
}

/** Toggle collapsing OS-owned modules; their symbols resolve from Microsoft. */
export function systemModulesToggleLabel(count: number, expanded: boolean): string {
  const noun = count === 1 ? "module" : "modules";
  return expanded
    ? `Hide ${count} Windows system ${noun}`
    : `Show ${count} Windows system ${noun} (symbols served by Microsoft)`;
}
