/**
 * Stepwise import pipeline: validate first (manifest parse, consistency
 * checks, schema-migration gate, strict tar layout), then replay entity rows
 * in dependency order (customers, cases, grants, dumps) through the same
 * engine transitions the live paths use. Audit events replay verbatim last;
 * FinishImport lands only when every row arrived.
 *
 * The session split exposes the per-record steps the transfer model
 * observes: begin() writes the BeginImport marker, every per-record step
 * lands exactly one row, finish() replays audit events and writes
 * FinishImport, and abandon() drops the session without FinishImport — the
 * crash shape reconciliation looks for. importBundle() remains the one-shot
 * composition.
 *
 * Vault bytes for available dumps stream through SHA-256 while staging; a
 * size or hash mismatch (including operator-tampered bundles) lands the dump
 * in rejected with the original manifest hash recorded. Grants exported
 * under a different grant key are force-imported as revoked: issued secrets
 * must never become usable on an instance with a different grant key.
 */

import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { DumpLedgerError } from "../domain/errors.js";
import { parseAuditEventId, parseCaseId, parseCustomerId, parseDumpId, parseGrantId, type AuditEventId, type CaseId, type CustomerId, type DumpId, type GrantId } from "../domain/ids.js";
import { isCoverageKind, parseCaseStatus, parseDumpPhase, parseTokenState, parseValidationState, type CoverageKind, type DumpPhase, type ValidationState } from "../domain/lifecycle.js";
import type { ImportAuditEventRecord, ImportCaseRecord, ImportCounts, ImportCustomerRecord, ImportDumpRecord, ImportGrantRecord } from "../engine/commands.js";
import type { DumpLedgerEngine } from "../engine/dump-ledger-engine.js";
import type { TransitionReceipt, TransitionSuccess } from "../engine/projection.js";
import { applyMigrations } from "../ledger/migrations.js";
import type { Vault } from "../vault/vault.js";
import { MAX_MANIFEST_BYTES, dumpEntryName, parseExportManifest, type ExportManifest } from "./manifest.js";
import { readTar, type TarEntry, type TarSource } from "./tar.js";

const MAX_BUNDLE_PATH_LENGTH = 1024;
const MAX_BUNDLE_ENTRIES = 1_000_002; // manifest + ledger + up to 1_000_000 dumps
const DEFAULT_MAX_BUNDLE_BYTES = BigInt(Number.MAX_SAFE_INTEGER);
const DEFAULT_MAX_LEDGER_BYTES = 8n * 1024n * 1024n * 1024n; // bound on the temp ledger copy
const IMPORT_HASH_MISMATCH = "import sha256 mismatch";
const VAULT_ENTRY_PATTERN = /^vault\/(dump_[0-9A-HJKMNP-TV-Z]{26})\/original\.dmp$/;
const REQUIRED_TABLES = ["schema_migrations", "customers", "cases", "upload_grants", "dumps", "audit_events"] as const;

export interface ImportBundleOptions {
  readonly engine: DumpLedgerEngine;
  readonly vault: Vault;
  readonly bundlePath: string;
  /** Parent directory for the temporary ledger copy; defaults to a fresh directory under the OS temp dir. */
  readonly workDir?: string;
  readonly maxBundleBytes?: bigint;
  readonly maxLedgerBytes?: bigint;
  readonly maxManifestBytes?: number;
}

export interface ImportOutcome {
  readonly status: "finished" | "failed";
  /** Available dumps whose streamed bytes matched the manifest hash and size. */
  readonly verified: number;
  /** Dumps that reached available, plus deleted tombstones imported. */
  readonly imported: number;
  /** Dumps that landed in rejected (hash/size mismatch, inspection failure, or source-rejected tombstone). */
  readonly rejected: number;
  /** Dumps recorded in manifest.skipped (not stable at export time, deliberately left behind). */
  readonly skipped: number;
  /** Engine-side BeginImport marker id; null when validation failed before any engine mutation. */
  readonly engineImportId: AuditEventId | null;
  readonly error: string | null;
}

export interface Counters {
  verified: number;
  imported: number;
  rejected: number;
  skipped: number;
}

function invalid(message: string): DumpLedgerError {
  return new DumpLedgerError("invalid_input", message);
}

function corrupt(message: string): DumpLedgerError {
  return new DumpLedgerError("integrity_failure", message);
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 2000 ? `${message.slice(0, 1997)}...` : message;
}

function requireOk(receipt: TransitionReceipt): TransitionSuccess {
  if (!receipt.ok) throw new DumpLedgerError(receipt.error.code, receipt.error.message);
  return receipt;
}

/** Random-access tar source over an open file descriptor; never buffers the bundle. */
class FileTarSource implements TarSource {
  readonly size: bigint;

  private constructor(private readonly descriptor: number, size: bigint) {
    this.size = size;
  }

  static open(path: string): FileTarSource {
    const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = fstatSync(descriptor, { bigint: true });
      if (!info.isFile()) throw invalid("bundle path must be a regular file");
      return new FileTarSource(descriptor, info.size);
    } catch (error) {
      closeSync(descriptor);
      throw error;
    }
  }

  read(position: bigint, length: number): Uint8Array {
    if (position < 0n || position > BigInt(Number.MAX_SAFE_INTEGER) || length < 0) throw new RangeError("invalid tar read range");
    const buffer = Buffer.alloc(length);
    const count = readSync(this.descriptor, buffer, 0, length, Number(position));
    return Uint8Array.from(buffer.subarray(0, count));
  }

  close(): void {
    closeSync(this.descriptor);
  }
}

function checkBundlePath(raw: string): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_BUNDLE_PATH_LENGTH) throw invalid("bundle path is invalid");
  const path = resolve(raw);
  if (!path.endsWith(".tar")) throw invalid("bundle path must end with .tar");
  let info;
  try {
    info = lstatSync(path);
  } catch {
    throw new DumpLedgerError("not_found", "bundle path does not exist");
  }
  if (info.isSymbolicLink()) throw invalid("bundle path must not be a symbolic link");
  if (!info.isFile()) throw invalid("bundle path must be a regular file");
  return path;
}

/** Collects and layout-checks every entry (import is not streaming-ordered: validate first, process after). */
function collectEntries(source: TarSource, maxBundleBytes: bigint, maxManifestBytes: number, maxLedgerBytes: bigint): ReadonlyMap<string, TarEntry> {
  const entries = new Map<string, TarEntry>();
  for (const entry of readTar(source, { maxEntries: MAX_BUNDLE_ENTRIES, maxBytes: maxBundleBytes })) {
    if (entry.name !== "manifest.json" && entry.name !== "ledger.sqlite" && !VAULT_ENTRY_PATTERN.test(entry.name)) {
      throw invalid(`bundle carries an unexpected tar entry: ${JSON.stringify(entry.name)}`);
    }
    entries.set(entry.name, entry);
  }
  const manifest = entries.get("manifest.json");
  if (manifest === undefined) throw invalid("bundle is missing manifest.json");
  if (manifest.size === 0n || manifest.size > BigInt(maxManifestBytes)) throw invalid(`bundle manifest exceeds the ${maxManifestBytes} byte bound`);
  const ledger = entries.get("ledger.sqlite");
  if (ledger === undefined) throw invalid("bundle is missing ledger.sqlite");
  if (ledger.size === 0n || ledger.size > maxLedgerBytes) throw invalid(`bundle ledger exceeds the ${maxLedgerBytes} byte bound`);
  return entries;
}

function readEntryBytes(entry: TarEntry): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const chunk of entry.chunks()) chunks.push(chunk);
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (BigInt(result.byteLength) !== entry.size) throw corrupt(`tar entry ${entry.name} delivered fewer bytes than declared`);
  return result;
}

function writeEntryToFile(entry: TarEntry, path: string): void {
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    for (const chunk of entry.chunks()) {
      let written = 0;
      while (written < chunk.byteLength) {
        const count = writeSync(descriptor, chunk, written, chunk.byteLength - written);
        if (count === 0) throw new DumpLedgerError("storage_unavailable", "bundle ledger copy write made no progress");
        written += count;
      }
    }
  } finally {
    closeSync(descriptor);
  }
}

/** The running schema version: replay the migrations onto a scratch database and read what they installed. */
function currentSchemaVersion(): number {
  const database = new BetterSqlite3(":memory:");
  try {
    applyMigrations(database);
    const row = database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as { version: number | bigint };
    return Number(row.version);
  } finally {
    database.close();
  }
}

type Row = Record<string, unknown>;

function rowString(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw corrupt(`bundle ledger column ${key} is not a string`);
  return value;
}

function rowNullableString(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string") throw corrupt(`bundle ledger column ${key} is not a string or null`);
  return value;
}

function rowIso(row: Row, key: string): string {
  const value = rowString(row, key);
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw corrupt(`bundle ledger column ${key} is not a canonical ISO timestamp`);
  return value;
}

function rowNullableIso(row: Row, key: string): string | null {
  const value = rowNullableString(row, key);
  if (value === null) return null;
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw corrupt(`bundle ledger column ${key} is not a canonical ISO timestamp`);
  return value;
}

function rowDecimal(row: Row, key: string): bigint {
  const value = rowString(row, key);
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw corrupt(`bundle ledger column ${key} is not a canonical decimal`);
  return BigInt(value);
}

function rowNullableDecimal(row: Row, key: string): bigint | null {
  const value = rowNullableString(row, key);
  if (value === null) return null;
  if (!/^(0|[1-9][0-9]*)$/.test(value)) throw corrupt(`bundle ledger column ${key} is not a canonical decimal`);
  return BigInt(value);
}

function rowId<T>(row: Row, key: string, parse: (value: unknown) => T): T {
  try {
    return parse(rowString(row, key));
  } catch {
    throw corrupt(`bundle ledger column ${key} is not a valid identifier`);
  }
}

function rowNullableId<T>(row: Row, key: string, parse: (value: unknown) => T): T | null {
  const value = rowNullableString(row, key);
  if (value === null) return null;
  try {
    return parse(value);
  } catch {
    throw corrupt(`bundle ledger column ${key} is not a valid identifier`);
  }
}

function rowEnum<T>(row: Row, key: string, parse: (value: unknown) => T): T {
  try {
    return parse(row[key]);
  } catch {
    throw corrupt(`bundle ledger column ${key} is not a valid enum value`);
  }
}

function rowNullableCoverage(row: Row, key: string): CoverageKind | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string" || !isCoverageKind(value)) throw corrupt(`bundle ledger column ${key} is not a valid coverage kind`);
  return value;
}

function rowJsonObject(row: Row, key: string): Readonly<Record<string, unknown>> | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string") throw corrupt(`bundle ledger column ${key} is not JSON text`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw corrupt(`bundle ledger column ${key} is not valid JSON`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw corrupt(`bundle ledger column ${key} is not a JSON object`);
  return parsed as Readonly<Record<string, unknown>>;
}

export interface BundleDumpRow {
  readonly dumpId: DumpId;
  readonly caseId: CaseId;
  readonly phase: DumpPhase;
  readonly originalName: string;
  readonly byteSize: bigint | null;
  readonly sha256: string | null;
  readonly validation: ValidationState;
  readonly coverage: CoverageKind | null;
  readonly inspectionError: string | null;
  readonly inspectionFacts: Readonly<Record<string, unknown>> | null;
  readonly receivedAt: string;
  readonly availableAt: string | null;
  readonly purgeAt: string | null;
  readonly purgedAt: string | null;
}

export interface BundleRows {
  readonly customers: readonly ImportCustomerRecord[];
  readonly cases: readonly ImportCaseRecord[];
  readonly grants: readonly ImportGrantRecord[];
  readonly dumps: readonly BundleDumpRow[];
  readonly auditEvents: readonly ImportAuditEventRecord[];
}

function readBundleLedger(copyPath: string, currentVersion: number): BundleRows {
  let database: BetterSqlite3.Database | undefined;
  try {
    database = new BetterSqlite3(copyPath, { readonly: true });
    const bundleVersion = (database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as { version: number | bigint }).version;
    for (const table of REQUIRED_TABLES) {
      const present = database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
      if (present === undefined) throw corrupt(`bundle ledger is missing the ${table} table`);
    }
    if (Number(bundleVersion) > currentVersion) throw invalid(`bundle schema version ${Number(bundleVersion)} is newer than this instance's ${currentVersion}`);
    if (Number(bundleVersion) < currentVersion) applyMigrations(database);

    const customers = (database.prepare("SELECT customer_id, display_name, created_at FROM customers ORDER BY customer_id").all() as Row[]).map((row): ImportCustomerRecord => ({
      customerId: rowId(row, "customer_id", parseCustomerId),
      displayName: rowString(row, "display_name"),
      createdAt: rowIso(row, "created_at"),
    }));
    const cases = (database.prepare("SELECT case_id, customer_id, title, status, created_at FROM cases ORDER BY case_id").all() as Row[]).map((row): ImportCaseRecord => ({
      caseId: rowId(row, "case_id", parseCaseId),
      customerId: rowId(row, "customer_id", parseCustomerId),
      title: rowString(row, "title"),
      status: rowEnum(row, "status", parseCaseStatus),
      createdAt: rowIso(row, "created_at"),
    }));
    const grants = (database.prepare("SELECT grant_id, case_id, secret_digest, state, expires_at, max_bytes, consumed_by_dump_id, created_at FROM upload_grants ORDER BY grant_id").all() as Row[]).map((row): ImportGrantRecord => ({
      grantId: rowId(row, "grant_id", parseGrantId),
      caseId: rowId(row, "case_id", parseCaseId),
      secretDigest: rowString(row, "secret_digest"),
      state: rowEnum(row, "state", parseTokenState),
      expiresAt: rowIso(row, "expires_at"),
      maxBytes: rowDecimal(row, "max_bytes"),
      consumedByDumpId: rowNullableId(row, "consumed_by_dump_id", parseDumpId),
      createdAt: rowIso(row, "created_at"),
    }));
    const dumps = (database.prepare("SELECT dump_id, case_id, phase, original_name, byte_size, sha256, validation, coverage, inspection_error, inspection_facts_json, received_at, available_at, purge_at, purged_at FROM dumps ORDER BY dump_id").all() as Row[]).map((row): BundleDumpRow => ({
      dumpId: rowId(row, "dump_id", parseDumpId),
      caseId: rowId(row, "case_id", parseCaseId),
      phase: rowEnum(row, "phase", parseDumpPhase),
      originalName: rowString(row, "original_name"),
      byteSize: rowNullableDecimal(row, "byte_size"),
      sha256: rowNullableString(row, "sha256"),
      validation: rowEnum(row, "validation", parseValidationState),
      coverage: rowNullableCoverage(row, "coverage"),
      inspectionError: rowNullableString(row, "inspection_error"),
      inspectionFacts: rowJsonObject(row, "inspection_facts_json"),
      receivedAt: rowIso(row, "received_at"),
      availableAt: rowNullableIso(row, "available_at"),
      purgeAt: rowNullableIso(row, "purge_at"),
      purgedAt: rowNullableIso(row, "purged_at"),
    }));
    const auditEvents = (database.prepare("SELECT event_id, occurred_at, action, customer_id, case_id, dump_id, detail_json FROM audit_events ORDER BY rowid").all() as Row[]).map((row): ImportAuditEventRecord => ({
      eventId: rowId(row, "event_id", parseAuditEventId),
      occurredAt: rowIso(row, "occurred_at"),
      action: rowString(row, "action"),
      customerId: rowNullableId(row, "customer_id", parseCustomerId),
      caseId: rowNullableId(row, "case_id", parseCaseId),
      dumpId: rowNullableId(row, "dump_id", parseDumpId),
      detail: rowJsonObject({ detail: row.detail_json }, "detail") ?? {},
    }));
    return { customers, cases, grants, dumps, auditEvents };
  } catch (error) {
    if (error instanceof DumpLedgerError) throw error;
    throw corrupt(`bundle ledger could not be read as a DumpLedger SQLite database: ${errorMessage(error)}`);
  } finally {
    if (database !== undefined) {
      try {
        database.close();
      } catch {
        // closing the scratch copy is best effort; the temp directory is removed regardless.
      }
    }
  }
}

/**
 * Verifies that manifest, bundle ledger rows, and tar entries agree. Skipped
 * dumps are matched by id only: a dump skipped at snapshot time may have
 * advanced phase by the time the consistent backup ran, and it is left
 * behind regardless (its bytes were never promised).
 */
function checkConsistency(manifest: ExportManifest, rows: BundleRows, entries: ReadonlyMap<string, TarEntry>): void {
  const rowsById = new Map(rows.dumps.map(row => [row.dumpId, row]));
  const manifestById = new Map(manifest.dumps.map(dump => [dump.dumpId, dump]));
  const skippedIds = new Set(manifest.skipped.map(entry => entry.dumpId));
  for (const declared of manifest.dumps) {
    const row = rowsById.get(declared.dumpId);
    if (row === undefined) throw corrupt(`manifest dump ${declared.dumpId} is missing from the bundle ledger`);
    if (row.phase !== declared.phase) throw corrupt(`bundle ledger phase ${row.phase} disagrees with manifest phase ${declared.phase} for ${declared.dumpId}`);
    if (row.caseId !== declared.caseId || row.originalName !== declared.originalName) throw corrupt(`bundle ledger row disagrees with the manifest for ${declared.dumpId}`);
    if (row.byteSize !== declared.byteSize || row.sha256 !== declared.sha256) throw corrupt(`bundle ledger size or hash disagrees with the manifest for ${declared.dumpId}`);
    if (declared.phase === "available") {
      const name = dumpEntryName(declared.dumpId);
      if (!entries.has(name)) throw corrupt(`bundle is missing ${name}, which the manifest promises`);
    }
  }
  for (const row of rows.dumps) {
    if (manifestById.has(row.dumpId)) continue;
    if (!skippedIds.has(row.dumpId)) throw corrupt(`bundle ledger dump ${row.dumpId} (${row.phase}) appears in neither the manifest nor its skipped list`);
  }
  for (const name of entries.keys()) {
    if (name === "manifest.json" || name === "ledger.sqlite") continue;
    const match = VAULT_ENTRY_PATTERN.exec(name);
    const idText = match?.[1];
    if (idText === undefined) throw invalid(`bundle carries an unexpected tar entry: ${JSON.stringify(name)}`);
    const declared = manifestById.get(parseDumpId(idText));
    if (declared === undefined || declared.phase !== "available") throw invalid(`bundle carries vault bytes for ${idText}, which the manifest does not export as available`);
  }
  if (manifest.counts.customers !== rows.customers.length) throw corrupt("manifest customer count disagrees with the bundle ledger");
  if (manifest.counts.cases !== rows.cases.length) throw corrupt("manifest case count disagrees with the bundle ledger");
  if (manifest.counts.grants !== rows.grants.length) throw corrupt("manifest grant count disagrees with the bundle ledger");
  if (manifest.counts.auditEvents !== undefined) {
    const expected = rows.auditEvents.filter(event => event.dumpId === null || manifestById.has(event.dumpId)).length;
    if (manifest.counts.auditEvents !== expected) throw corrupt("manifest audit event count disagrees with the bundle ledger");
  }
}

function stagedRecord(row: BundleDumpRow): ImportDumpRecord {
  if (row.byteSize === null || row.sha256 === null) throw corrupt(`available manifest dump ${row.dumpId} has no size or hash in the bundle ledger`);
  return {
    dumpId: row.dumpId,
    caseId: row.caseId,
    phase: "available",
    originalName: row.originalName,
    byteSize: row.byteSize,
    sha256: row.sha256,
    validation: "not-checked",
    coverage: null,
    inspectionError: null,
    receivedAt: row.receivedAt,
    availableAt: null,
    purgeAt: row.purgeAt,
    purgedAt: null,
  };
}

function mismatchTombstone(row: BundleDumpRow): ImportDumpRecord {
  return {
    dumpId: row.dumpId,
    caseId: row.caseId,
    phase: "rejected",
    originalName: row.originalName,
    byteSize: row.byteSize,
    sha256: row.sha256,
    validation: "transfer-failed",
    coverage: null,
    inspectionError: IMPORT_HASH_MISMATCH,
    receivedAt: row.receivedAt,
    availableAt: null,
    purgeAt: row.purgeAt,
    purgedAt: null,
  };
}

function tombstoneRecord(row: BundleDumpRow, phase: "rejected" | "deleted"): ImportDumpRecord {
  return {
    dumpId: row.dumpId,
    caseId: row.caseId,
    phase,
    originalName: row.originalName,
    byteSize: row.byteSize,
    sha256: row.sha256,
    validation: row.validation,
    coverage: row.coverage,
    inspectionError: row.inspectionError,
    ...(row.inspectionFacts !== null ? { inspectionFacts: row.inspectionFacts } : {}),
    receivedAt: row.receivedAt,
    availableAt: row.availableAt,
    purgeAt: row.purgeAt,
    purgedAt: row.purgedAt,
  };
}

function toImportCounts(counts: ExportManifest["counts"]): ImportCounts {
  return {
    customers: counts.customers,
    cases: counts.cases,
    grants: counts.grants,
    dumps: counts.dumps,
    ...(counts.auditEvents !== undefined ? { auditEvents: counts.auditEvents } : {}),
  };
}

/** What stageDump did with one declared dump. */
export type ImportDumpDisposition =
  | "staged"             // bytes verified; the row landed sealed/staging
  | "mismatch"           // hash/size mismatch; rejected tombstone with the declared hash
  | "tombstone-rejected" // source-rejected tombstone, metadata only
  | "tombstone-deleted"; // source-deleted tombstone, metadata only

/**
 * An open import: every validation gate has passed and the bundle rows are
 * parsed. The steps land rows through the engine in whatever order the
 * caller chooses (the engine enforces the foreign-key order); finish()
 * requires every entity row and every declared dump to have been stepped.
 */
export interface ImportSession {
  readonly bundlePath: string;
  readonly manifest: ExportManifest;
  readonly manifestDigest: string;
  readonly rows: BundleRows;
  /** Whether the bundle's grant-key fingerprint differs from this instance's key. */
  readonly fingerprintMismatch: boolean;
  /** Engine-side BeginImport marker id; null until begin(). */
  readonly engineImportId: AuditEventId | null;
  /** Writes the BeginImport marker; exactly once per session. */
  begin(): void;
  importCustomer(customerId: CustomerId): void;
  importCase(caseId: CaseId): void;
  importGrant(grantId: GrantId): void;
  /**
   * Dispositions one declared dump: available dumps stream through SHA-256
   * into staging (a mismatch lands a rejected tombstone), rejected/deleted
   * dumps land as metadata tombstones.
   */
  stageDump(dumpId: DumpId): ImportDumpDisposition;
  /**
   * Replays the historical audit events and writes FinishImport. Requires
   * every customer, case, grant, and declared dump to have been stepped.
   */
  finish(): void;
  /**
   * Drops the session without FinishImport: partial ledger/vault state
   * persists, exactly the crash shape reconciliation looks for.
   */
  abandon(): void;
  /** Releases the tar source and removes the work directory; idempotent. */
  close(): void;
}

/**
 * Opens an import session: every validation gate (path, layout, manifest,
 * schema version, ledger copy, row parsing, manifest/ledger/entry
 * consistency) runs here, before any engine mutation.
 */
export function openImportSession(options: ImportBundleOptions): ImportSession {
  const bundlePath = checkBundlePath(options.bundlePath);
  const source = FileTarSource.open(bundlePath);
  let workDir: string | undefined;
  try {
    const maxManifestBytes = options.maxManifestBytes ?? MAX_MANIFEST_BYTES;
    const maxLedgerBytes = options.maxLedgerBytes ?? DEFAULT_MAX_LEDGER_BYTES;
    const entries = collectEntries(source, options.maxBundleBytes ?? DEFAULT_MAX_BUNDLE_BYTES, maxManifestBytes, maxLedgerBytes);
    const manifestEntry = entries.get("manifest.json");
    const ledgerEntry = entries.get("ledger.sqlite");
    if (manifestEntry === undefined || ledgerEntry === undefined) throw invalid("bundle is missing its manifest or ledger entry");
    const manifestBytes = readEntryBytes(manifestEntry);
    const manifest = parseExportManifest(manifestBytes);
    const manifestDigest = createHash("sha256").update(manifestBytes).digest("base64url");
    const runningVersion = currentSchemaVersion();
    if (manifest.generator.schemaMigrations > runningVersion) {
      throw invalid(`bundle schema version ${manifest.generator.schemaMigrations} is newer than this instance's ${runningVersion}`);
    }
    if (options.workDir !== undefined) mkdirSync(options.workDir, { recursive: true, mode: 0o700 });
    workDir = mkdtempSync(join(options.workDir ?? tmpdir(), "import-"));
    const ledgerCopyPath = join(workDir, "ledger.sqlite");
    writeEntryToFile(ledgerEntry, ledgerCopyPath);
    const rows = readBundleLedger(ledgerCopyPath, runningVersion);
    checkConsistency(manifest, rows, entries);

    const engine = options.engine;
    const vault = options.vault;
    const fingerprintMismatch = engine.grantKeyFingerprint() !== manifest.grantKeyFingerprint;
    const manifestById = new Map(manifest.dumps.map(dump => [dump.dumpId, dump]));
    const customersById = new Map(rows.customers.map(row => [row.customerId, row]));
    const casesById = new Map(rows.cases.map(row => [row.caseId, row]));
    const grantsById = new Map(rows.grants.map(row => [row.grantId, row]));
    const steppedCustomers = new Set<CustomerId>();
    const steppedCases = new Set<CaseId>();
    const steppedGrants = new Set<GrantId>();
    const steppedDumps = new Set<DumpId>();
    let engineImportId: AuditEventId | null = null;
    let phase: "open" | "began" | "finished" | "abandoned" = "open";
    let closed = false;

    const requirePhase = (...allowed: readonly string[]): void => {
      if (!allowed.includes(phase)) throw new DumpLedgerError("invalid_transition", `import session is ${phase}`);
    };
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      try {
        source.close();
      } catch {
        // best effort
      }
      if (workDir !== undefined) rmSync(workDir, { recursive: true, force: true });
    };

    const session: ImportSession = {
      bundlePath,
      manifest,
      manifestDigest,
      rows,
      fingerprintMismatch,
      get engineImportId() { return engineImportId; },
      begin(): void {
        requirePhase("open");
        const begin = requireOk(engine.execute({ type: "BeginImport", manifestDigest, counts: toImportCounts(manifest.counts) }));
        if (begin.importId === undefined) throw corrupt("BeginImport succeeded without an import id");
        engineImportId = begin.importId;
        phase = "began";
      },
      importCustomer(customerId: CustomerId): void {
        requirePhase("began");
        const record = customersById.get(customerId);
        if (record === undefined) throw invalid(`bundle has no customer ${customerId}`);
        if (steppedCustomers.has(customerId)) throw invalid(`customer ${customerId} was already imported`);
        requireOk(engine.execute({ type: "ImportCustomer", record }));
        steppedCustomers.add(customerId);
      },
      importCase(caseId: CaseId): void {
        requirePhase("began");
        const record = casesById.get(caseId);
        if (record === undefined) throw invalid(`bundle has no case ${caseId}`);
        if (steppedCases.has(caseId)) throw invalid(`case ${caseId} was already imported`);
        requireOk(engine.execute({ type: "ImportCase", record }));
        steppedCases.add(caseId);
      },
      importGrant(grantId: GrantId): void {
        requirePhase("began");
        const record = grantsById.get(grantId);
        if (record === undefined) throw invalid(`bundle has no grant ${grantId}`);
        if (steppedGrants.has(grantId)) throw invalid(`grant ${grantId} was already imported`);
        requireOk(engine.execute({ type: "ImportGrant", record, ...(fingerprintMismatch ? { forcedState: "revoked" as const } : {}) }));
        steppedGrants.add(grantId);
      },
      stageDump(dumpId: DumpId): ImportDumpDisposition {
        requirePhase("began");
        const declared = manifestById.get(dumpId);
        if (declared === undefined) throw invalid(`bundle does not declare dump ${dumpId}`);
        if (steppedDumps.has(dumpId)) throw invalid(`dump ${dumpId} was already staged`);
        const row = rows.dumps.find(candidate => candidate.dumpId === dumpId);
        if (row === undefined) throw corrupt(`bundle ledger is missing declared dump ${dumpId}`);
        if (declared.phase === "available") {
          const entry = entries.get(dumpEntryName(dumpId));
          if (entry === undefined || row.byteSize === null || row.sha256 === null) throw corrupt(`bundle is internally inconsistent for ${dumpId}`);
          let digest: string | null = null;
          if (entry.size === row.byteSize) {
            vault.createStaging(dumpId);
            try {
              const hasher = createHash("sha256");
              for (const chunk of entry.chunks()) {
                hasher.update(chunk);
                vault.append(dumpId, chunk);
              }
              vault.syncAndClose(dumpId);
              digest = hasher.digest("hex");
            } catch (error) {
              // No ledger row exists yet: remove the staging residue before surfacing.
              vault.removeStaging(dumpId);
              throw error;
            }
          }
          if (digest === null || digest !== row.sha256) {
            if (digest !== null) vault.removeStaging(dumpId);
            requireOk(engine.execute({ type: "ImportDumpStaged", record: mismatchTombstone(row) }));
            steppedDumps.add(dumpId);
            return "mismatch";
          }
          requireOk(engine.execute({ type: "ImportDumpStaged", record: stagedRecord(row) }));
          steppedDumps.add(dumpId);
          return "staged";
        }
        requireOk(engine.execute({ type: "ImportDumpStaged", record: tombstoneRecord(row, declared.phase) }));
        steppedDumps.add(dumpId);
        return declared.phase === "rejected" ? "tombstone-rejected" : "tombstone-deleted";
      },
      finish(): void {
        requirePhase("began");
        if (steppedCustomers.size !== rows.customers.length
          || steppedCases.size !== rows.cases.length
          || steppedGrants.size !== rows.grants.length
          || steppedDumps.size !== manifestById.size) {
          throw new DumpLedgerError("invalid_transition", "import finish requires every declared row to have been imported");
        }
        const importId = engineImportId;
        if (importId === null) throw corrupt("BeginImport succeeded without an import id");
        // Historical audit events land after every entity exists (FK references), replayed in original order.
        let auditImported = 0;
        for (const event of rows.auditEvents) {
          if (event.dumpId !== null && !manifestById.has(event.dumpId)) continue; // references a dump left behind at export
          requireOk(engine.execute({ type: "ImportAuditEvent", record: event }));
          auditImported += 1;
        }
        requireOk(engine.execute({
          type: "FinishImport",
          importId,
          summary: {
            imported: { customers: rows.customers.length, cases: rows.cases.length, grants: rows.grants.length, dumps: manifest.dumps.length, auditEvents: auditImported },
            skipped: manifest.skipped.length,
          },
        }));
        phase = "finished";
        cleanup();
      },
      abandon(): void {
        if (phase === "finished" || phase === "abandoned") return;
        phase = "abandoned";
        cleanup();
      },
      close(): void {
        cleanup();
      },
    };
    return session;
  } catch (error) {
    try {
      source.close();
    } catch {
      // best effort
    }
    if (workDir !== undefined) rmSync(workDir, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Runs one import. Validation or engine failures return a failed outcome;
 * a failure after BeginImport deliberately never reaches FinishImport.
 */
export function importBundle(options: ImportBundleOptions): ImportOutcome {
  const counters: Counters = { verified: 0, imported: 0, rejected: 0, skipped: 0 };
  let engineImportId: AuditEventId | null = null;
  let session: ImportSession | undefined;
  try {
    session = openImportSession(options);
    counters.skipped = session.manifest.skipped.length;
    session.begin();
    engineImportId = session.engineImportId;
    for (const customer of session.rows.customers) session.importCustomer(customer.customerId);
    for (const caseRow of session.rows.cases) session.importCase(caseRow.caseId);
    for (const grant of session.rows.grants) session.importGrant(grant.grantId);
    const engine = options.engine;
    for (const row of session.rows.dumps) {
      const declared = session.manifest.dumps.find(dump => dump.dumpId === row.dumpId);
      if (declared === undefined) continue; // skipped at export time: left behind deliberately
      const disposition = session.stageDump(row.dumpId);
      if (disposition === "staged") {
        counters.verified += 1;
        requireOk(engine.execute({ type: "PromoteObject", dumpId: row.dumpId }));
        requireOk(engine.execute({ type: "MarkQuarantined", dumpId: row.dumpId }));
        const accepted = engine.execute({ type: "AcceptDump", dumpId: row.dumpId });
        if (accepted.ok) {
          counters.imported += 1;
        } else {
          if (accepted.error.code !== "inspection_outcome_mismatch") throw new DumpLedgerError(accepted.error.code, accepted.error.message);
          requireOk(engine.execute({ type: "RejectDump", dumpId: row.dumpId }));
          counters.rejected += 1;
        }
      } else if (disposition === "tombstone-deleted") {
        counters.imported += 1;
      } else {
        counters.rejected += 1;
      }
    }
    session.finish();
    return { status: "finished", ...counters, engineImportId, error: null };
  } catch (error) {
    return { status: "failed", ...counters, engineImportId, error: errorMessage(error) };
  } finally {
    session?.close();
  }
}
