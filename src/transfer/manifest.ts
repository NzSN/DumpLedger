/**
 * Export manifest schema `dump-ledger.export-manifest/v1`: the self-describing
 * inventory of an export bundle. `serializeExportManifest` produces the
 * canonical bytes the exporter writes as the first tar entry (and the exact
 * bytes the importer digests into BeginImport). `parseExportManifest` is the
 * importer's strict validator for untrusted manifest bytes: every field is
 * type-checked, strings and lists are bounded, sizes are canonical decimal
 * strings, and identifiers pass the branded-ID parsers from src/domain/ids.
 * (JSON duplicate keys are not detected; the exact key-set checks plus the
 * ledger/tar cross-checks in import.ts bound that abuse surface.)
 */

import { DumpLedgerError } from "../domain/errors.js";
import { parseCaseId, parseDumpId, parseSymbolArtifactId, type CaseId, type DumpId, type SymbolArtifactId } from "../domain/ids.js";
import { parseDumpPhase, type DumpPhase } from "../domain/lifecycle.js";

export const EXPORT_MANIFEST_SCHEMA = "dump-ledger.export-manifest/v1";
/** Highest accepted manifest size in bytes; the manifest scales with ledger row counts, never with dump bytes. */
export const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
/** Highest accepted length of the dumps and skipped lists. */
export const MAX_MANIFEST_LIST_ENTRIES = 1_000_000;

const MAX_ORIGINAL_NAME_LENGTH = 1024;
const MAX_VERSION_LENGTH = 64;
const MAX_REASON_LENGTH = 200;
/* Bounds mirror the engine's SealSymbol assertions (src/engine/dump-ledger-engine.ts). */
const MAX_SYMBOL_DEBUG_FILE_LENGTH = 255;
const MAX_SYMBOL_DEBUG_ID_LENGTH = 64;
const MAX_SYMBOL_ANNOTATION_LENGTH = 200;
const MAX_SYMBOL_ARCH_LENGTH = 64;
const MAX_COUNT = 1_000_000_000;
const MAX_DECIMAL_DIGITS = 40;
const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const GRANT_KEY_FINGERPRINT_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UNSTABLE_PHASES: readonly DumpPhase[] = ["receiving", "sealed", "quarantined", "deleting"];

export type StableDumpPhase = "available" | "rejected" | "deleted";

function isStablePhase(phase: DumpPhase): phase is StableDumpPhase {
  return phase === "available" || phase === "rejected" || phase === "deleted";
}

export interface ExportManifestGenerator {
  readonly version: string;
  readonly schemaMigrations: number;
}

export interface ExportManifestCounts {
  readonly customers: number;
  readonly cases: number;
  readonly grants: number;
  readonly dumps: number;
  readonly auditEvents?: number;
  /** Number of carried symbol entries; present exactly when the symbols list is (the auditEvents precedent). */
  readonly symbols?: number;
}

export interface ExportManifestSkipped {
  readonly dumpId: DumpId;
  readonly phase: DumpPhase;
  readonly reason: string;
}

export interface ExportManifestDump {
  readonly dumpId: DumpId;
  readonly caseId: CaseId;
  readonly phase: StableDumpPhase;
  readonly originalName: string;
  readonly byteSize: bigint | null;
  readonly sha256: string | null;
  /** Tar entry carrying the bytes: exactly `vault/<dumpId>/original.dmp` for available dumps, null for tombstones. */
  readonly entry: string | null;
}

/**
 * One symbol artifact carried inside the bundle (design milestone 3,
 * `--include-symbols`; default off). The exporter only ever emits entries it
 * matched against the store by exact (debugFile, debugId); the importer
 * re-verifies the bytes and re-ingests them through the engine.
 */
export interface ExportManifestSymbol {
  readonly artifactId: SymbolArtifactId;
  readonly debugFile: string;
  readonly debugId: string;
  readonly kind: "pdb";
  readonly byteSize: bigint;
  readonly sha256: string;
  /** Tar entry carrying the bytes: exactly `symbols/<artifactId>.bin`. */
  readonly entry: string;
  readonly product?: string;
  readonly version?: string;
  readonly arch?: string;
}

export interface ExportManifest {
  readonly schema: typeof EXPORT_MANIFEST_SCHEMA;
  readonly createdAt: string;
  readonly generator: ExportManifestGenerator;
  readonly grantKeyFingerprint: string;
  readonly counts: ExportManifestCounts;
  readonly skipped: readonly ExportManifestSkipped[];
  readonly dumps: readonly ExportManifestDump[];
  /**
   * Optional symbol payload (the auditEvents precedent): absent on a bundle
   * exported without the flag, present (possibly empty) when the export
   * requested symbols. A bundle without the field has no symbol tar entries.
   */
  readonly symbols?: readonly ExportManifestSymbol[];
}

/** The canonical tar entry name carrying one exported dump's bytes. */
export function dumpEntryName(dumpId: DumpId): string {
  return `vault/${dumpId}/original.dmp`;
}

/** The canonical tar entry name carrying one exported symbol artifact's bytes. */
export function symbolEntryName(artifactId: SymbolArtifactId): string {
  return `symbols/${artifactId}.bin`;
}

function fail(path: string, message: string): never {
  throw new DumpLedgerError("invalid_input", `export manifest ${path}: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], path: string): void {
  for (const key of keys) if (!(key in value)) fail(path, `missing field ${JSON.stringify(key)}`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(path, `unknown field ${JSON.stringify(key)}`);
}

/** exactKeys with optional trailing fields: required keys must be present, optional keys may be absent, nothing else is allowed. */
function exactKeysAllowingOptional(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], path: string): void {
  for (const key of required) if (!(key in value)) fail(path, `missing field ${JSON.stringify(key)}`);
  for (const key of Object.keys(value)) if (!required.includes(key) && !optional.includes(key)) fail(path, `unknown field ${JSON.stringify(key)}`);
}

function textField(value: unknown, path: string, maxLength: number, pattern?: RegExp): string {
  if (typeof value !== "string") fail(path, "must be a string");
  if (value.length === 0) fail(path, "must not be empty");
  if (value.length > maxLength) fail(path, `exceeds ${maxLength} characters`);
  if (value.includes("\0")) fail(path, "contains a NUL character");
  if (pattern !== undefined && !pattern.test(value)) fail(path, "is malformed");
  return value;
}

function optionalTextField(value: unknown, path: string, maxLength: number): string | undefined {
  return value === undefined ? undefined : textField(value, path, maxLength);
}

function canonicalTimestampField(value: unknown, path: string): string {
  const text = textField(value, path, 40);
  if (!Number.isFinite(Date.parse(text)) || new Date(text).toISOString() !== text) fail(path, "must be a canonical ISO timestamp");
  return text;
}

function countField(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) fail(path, "must be a safe integer");
  if (value < 0 || value > MAX_COUNT) fail(path, `must be between 0 and ${MAX_COUNT}`);
  return value;
}

function decimalField(value: unknown, path: string): bigint {
  const text = textField(value, path, MAX_DECIMAL_DIGITS, DECIMAL_PATTERN);
  return BigInt(text);
}

function nullableDecimalField(value: unknown, path: string): bigint | null {
  return value === null ? null : decimalField(value, path);
}

function nullableSha256Field(value: unknown, path: string): string | null {
  return value === null ? null : textField(value, path, 64, SHA256_PATTERN);
}

function boundedList(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, "must be an array");
  if (value.length > MAX_MANIFEST_LIST_ENTRIES) fail(path, `exceeds ${MAX_MANIFEST_LIST_ENTRIES} entries`);
  return value;
}

function parseGenerator(value: unknown, path: string): ExportManifestGenerator {
  if (!isRecord(value)) fail(path, "must be an object");
  exactKeys(value, ["version", "schemaMigrations"], path);
  const version = textField(value.version, `${path}.version`, MAX_VERSION_LENGTH);
  const migrations = countField(value.schemaMigrations, `${path}.schemaMigrations`);
  return { version, schemaMigrations: migrations };
}

const COUNT_KEYS = ["customers", "cases", "grants", "dumps", "auditEvents", "symbols"] as const;
const REQUIRED_COUNT_KEYS = ["customers", "cases", "grants", "dumps"] as const;

/** `auditEvents` and `symbols` are optional (a pre-field bundle simply lacks them). */
function parseCounts(value: unknown, path: string): ExportManifestCounts {
  if (!isRecord(value)) fail(path, "must be an object");
  for (const key of REQUIRED_COUNT_KEYS) {
    if (!(key in value)) fail(path, `missing field ${JSON.stringify(key)}`);
  }
  for (const key of Object.keys(value)) if (!(COUNT_KEYS as readonly string[]).includes(key)) fail(path, `unknown field ${JSON.stringify(key)}`);
  const counts: ExportManifestCounts = {
    customers: countField(value.customers, `${path}.customers`),
    cases: countField(value.cases, `${path}.cases`),
    grants: countField(value.grants, `${path}.grants`),
    dumps: countField(value.dumps, `${path}.dumps`),
  };
  const withAudit = value.auditEvents !== undefined ? { ...counts, auditEvents: countField(value.auditEvents, `${path}.auditEvents`) } : counts;
  if (value.symbols !== undefined) return { ...withAudit, symbols: countField(value.symbols, `${path}.symbols`) };
  return withAudit;
}

function parseSkippedEntry(value: unknown, path: string): ExportManifestSkipped {
  if (!isRecord(value)) fail(path, "must be an object");
  exactKeys(value, ["dumpId", "phase", "reason"], path);
  let dumpId: DumpId;
  try {
    dumpId = parseDumpId(value.dumpId);
  } catch {
    return fail(`${path}.dumpId`, "is not a valid dump identifier");
  }
  let phase: DumpPhase;
  try {
    phase = parseDumpPhase(value.phase);
  } catch {
    return fail(`${path}.phase`, "is not a valid dump phase");
  }
  if (!UNSTABLE_PHASES.includes(phase)) fail(`${path}.phase`, "must be a non-stable phase");
  const reason = textField(value.reason, `${path}.reason`, MAX_REASON_LENGTH);
  return { dumpId, phase, reason };
}

function parseSymbolEntry(value: unknown, path: string): ExportManifestSymbol {
  if (!isRecord(value)) fail(path, "must be an object");
  exactKeysAllowingOptional(
    value,
    ["artifactId", "debugFile", "debugId", "kind", "byteSize", "sha256", "entry"],
    ["product", "version", "arch"],
    path,
  );
  let artifactId: SymbolArtifactId;
  try {
    artifactId = parseSymbolArtifactId(value.artifactId);
  } catch {
    return fail(`${path}.artifactId`, "is not a valid symbol artifact identifier");
  }
  if (value.kind !== "pdb") fail(`${path}.kind`, 'must be exactly "pdb"');
  // Case is preserved exactly: symbol resolution is a case-sensitive join on
  // (debugFile, debugId) (docs/symbols-design.md, "Identity model").
  const debugFile = textField(value.debugFile, `${path}.debugFile`, MAX_SYMBOL_DEBUG_FILE_LENGTH);
  const debugId = textField(value.debugId, `${path}.debugId`, MAX_SYMBOL_DEBUG_ID_LENGTH);
  const byteSize = decimalField(value.byteSize, `${path}.byteSize`);
  if (byteSize === 0n) fail(`${path}.byteSize`, "must be positive");
  const sha256 = textField(value.sha256, `${path}.sha256`, 64, SHA256_PATTERN);
  const entry = textField(value.entry, `${path}.entry`, 128);
  if (entry !== symbolEntryName(artifactId)) fail(`${path}.entry`, `must be ${JSON.stringify(symbolEntryName(artifactId))}`);
  const product = optionalTextField(value.product, `${path}.product`, MAX_SYMBOL_ANNOTATION_LENGTH);
  const version = optionalTextField(value.version, `${path}.version`, MAX_SYMBOL_ANNOTATION_LENGTH);
  const arch = optionalTextField(value.arch, `${path}.arch`, MAX_SYMBOL_ARCH_LENGTH);
  return {
    artifactId,
    debugFile,
    debugId,
    kind: "pdb",
    byteSize,
    sha256,
    entry,
    ...(product === undefined ? {} : { product }),
    ...(version === undefined ? {} : { version }),
    ...(arch === undefined ? {} : { arch }),
  };
}

function parseDumpEntry(value: unknown, path: string): ExportManifestDump {
  if (!isRecord(value)) fail(path, "must be an object");
  exactKeys(value, ["dumpId", "caseId", "phase", "originalName", "byteSize", "sha256", "entry"], path);
  let dumpId: DumpId;
  try {
    dumpId = parseDumpId(value.dumpId);
  } catch {
    return fail(`${path}.dumpId`, "is not a valid dump identifier");
  }
  let caseId: CaseId;
  try {
    caseId = parseCaseId(value.caseId);
  } catch {
    return fail(`${path}.caseId`, "is not a valid case identifier");
  }
  let phase: DumpPhase;
  try {
    phase = parseDumpPhase(value.phase);
  } catch {
    return fail(`${path}.phase`, "is not a valid dump phase");
  }
  if (!isStablePhase(phase)) fail(`${path}.phase`, "must be a stable phase");
  const originalName = textField(value.originalName, `${path}.originalName`, MAX_ORIGINAL_NAME_LENGTH);
  const byteSize = nullableDecimalField(value.byteSize, `${path}.byteSize`);
  const sha256 = nullableSha256Field(value.sha256, `${path}.sha256`);
  if (phase === "available") {
    if (byteSize === null) fail(`${path}.byteSize`, "is required for an available dump");
    if (sha256 === null) fail(`${path}.sha256`, "is required for an available dump");
    if (value.entry !== dumpEntryName(dumpId)) fail(`${path}.entry`, `must be ${JSON.stringify(dumpEntryName(dumpId))} for an available dump`);
    return { dumpId, caseId, phase, originalName, byteSize, sha256, entry: dumpEntryName(dumpId) };
  }
  if (value.entry !== null) fail(`${path}.entry`, "must be null for a tombstone dump");
  return { dumpId, caseId, phase, originalName, byteSize, sha256, entry: null };
}

/** Strictly validates untrusted manifest bytes into a trusted manifest. Throws DumpLedgerError("invalid_input"). */
export function parseExportManifest(bytes: Uint8Array): ExportManifest {
  if (bytes.byteLength === 0) fail("$", "is empty");
  if (bytes.byteLength > MAX_MANIFEST_BYTES) fail("$", `exceeds the ${MAX_MANIFEST_BYTES} byte manifest bound`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("$", "is not valid UTF-8");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return fail("$", "is not valid JSON");
  }
  if (!isRecord(value)) fail("$", "must be an object");
  exactKeysAllowingOptional(
    value,
    ["schema", "createdAt", "generator", "grantKeyFingerprint", "counts", "skipped", "dumps"],
    ["symbols"],
    "$",
  );
  if (value.schema !== EXPORT_MANIFEST_SCHEMA) fail("$.schema", `must be exactly ${JSON.stringify(EXPORT_MANIFEST_SCHEMA)}`);
  const createdAt = canonicalTimestampField(value.createdAt, "$.createdAt");
  const generator = parseGenerator(value.generator, "$.generator");
  const grantKeyFingerprint = textField(value.grantKeyFingerprint, "$.grantKeyFingerprint", 43, GRANT_KEY_FINGERPRINT_PATTERN);
  const counts = parseCounts(value.counts, "$.counts");
  const skipped = boundedList(value.skipped, "$.skipped").map((entry, index) => parseSkippedEntry(entry, `$.skipped[${index}]`));
  const dumps = boundedList(value.dumps, "$.dumps").map((entry, index) => parseDumpEntry(entry, `$.dumps[${index}]`));
  const symbols = value.symbols === undefined
    ? undefined
    : boundedList(value.symbols, "$.symbols").map((entry, index) => parseSymbolEntry(entry, `$.symbols[${index}]`));
  if (symbols === undefined && counts.symbols !== undefined) fail("$.symbols", "is required when counts.symbols is present");
  if (symbols !== undefined) {
    if (counts.symbols === undefined) fail("$.counts.symbols", "is required when the symbols list is present");
    if (counts.symbols !== symbols.length) fail("$.counts.symbols", `is ${counts.symbols} but the symbols list has ${symbols.length} entries`);
    const seenArtifacts = new Set<string>();
    const seenIdentities = new Set<string>();
    for (const symbol of symbols) {
      if (seenArtifacts.has(symbol.artifactId)) fail("$.symbols", `duplicate symbol artifact ${symbol.artifactId}`);
      seenArtifacts.add(symbol.artifactId);
      const identity = `${symbol.debugFile}\u0000${symbol.debugId}\u0000${symbol.kind}`;
      // The store's uniqueness is (debug_file, debug_id, kind): two entries
      // claiming one identity could never both have been exported.
      if (seenIdentities.has(identity)) fail("$.symbols", `duplicate symbol identity ${symbol.debugFile}/${symbol.debugId}`);
      seenIdentities.add(identity);
    }
  }
  const seen = new Set<string>();
  for (const dump of dumps) {
    if (seen.has(dump.dumpId)) fail("$.dumps", `duplicate dump ${dump.dumpId}`);
    seen.add(dump.dumpId);
  }
  for (const entry of skipped) {
    if (seen.has(entry.dumpId)) fail("$.skipped", `dump ${entry.dumpId} appears both as exported and as skipped`);
    seen.add(entry.dumpId);
  }
  if (counts.dumps !== dumps.length) fail("$.counts.dumps", `is ${counts.dumps} but the dumps list has ${dumps.length} entries`);
  return {
    schema: EXPORT_MANIFEST_SCHEMA,
    createdAt,
    generator,
    grantKeyFingerprint,
    counts,
    skipped,
    dumps,
    ...(symbols === undefined ? {} : { symbols }),
  };
}

/** Serializes a manifest to its canonical byte form (fixed key order, compact JSON, UTF-8). */
export function serializeExportManifest(manifest: ExportManifest): Uint8Array {
  const counts: Record<string, unknown> = {
    customers: manifest.counts.customers,
    cases: manifest.counts.cases,
    grants: manifest.counts.grants,
    dumps: manifest.counts.dumps,
  };
  if (manifest.counts.auditEvents !== undefined) counts.auditEvents = manifest.counts.auditEvents;
  if (manifest.counts.symbols !== undefined) counts.symbols = manifest.counts.symbols;
  const value = {
    schema: EXPORT_MANIFEST_SCHEMA,
    createdAt: manifest.createdAt,
    generator: { version: manifest.generator.version, schemaMigrations: manifest.generator.schemaMigrations },
    grantKeyFingerprint: manifest.grantKeyFingerprint,
    counts,
    skipped: manifest.skipped.map(entry => ({ dumpId: entry.dumpId, phase: entry.phase, reason: entry.reason })),
    dumps: manifest.dumps.map(dump => ({
      dumpId: dump.dumpId,
      caseId: dump.caseId,
      phase: dump.phase,
      originalName: dump.originalName,
      byteSize: dump.byteSize === null ? null : dump.byteSize.toString(),
      sha256: dump.sha256,
      entry: dump.entry,
    })),
    ...(manifest.symbols === undefined
      ? {}
      : {
          symbols: manifest.symbols.map(symbol => ({
            artifactId: symbol.artifactId,
            debugFile: symbol.debugFile,
            debugId: symbol.debugId,
            kind: symbol.kind,
            byteSize: symbol.byteSize.toString(),
            sha256: symbol.sha256,
            entry: symbol.entry,
            ...(symbol.product === undefined ? {} : { product: symbol.product }),
            ...(symbol.version === undefined ? {} : { version: symbol.version }),
            ...(symbol.arch === undefined ? {} : { arch: symbol.arch }),
          })),
        }),
  };
  return new TextEncoder().encode(JSON.stringify(value));
}
