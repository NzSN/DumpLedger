/**
 * Stepwise export pipeline: a consistent ledger backup (SQLite online backup
 * via engine.backup) plus the vault bytes of every stable-phase dump,
 * streamed into a tar bundle under <exportsDir>/<exportId>/ and sealed with
 * the vault's own discipline (fsync file, atomic rename, fsync directory —
 * the same-filesystem assumption holds inside data/).
 *
 * The session split exposes the two phases the transfer model observes
 * separately: opening a session takes the snapshot and computes the
 * selection (the frozen promised/rejected/deleted classification), and run()
 * streams + seals (or fails and removes the work directory). exportBundle()
 * remains the one-shot composition of both phases.
 *
 * Race policy (deviation from the design doc, simpler and honest): if a
 * selected dump's bytes vanish or change mid-copy (a concurrent purge
 * finishing), the whole export ABORTS with a failed, retryable summary and
 * removes its work directory — a bundle missing a promised manifest entry is
 * never sealed.
 */

import { randomBytes } from "node:crypto";
import { closeSync, constants, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import type { ExportSummary } from "@dump-ledger/http-contracts";
import { DumpLedgerError } from "../domain/errors.js";
import type { DumpLedgerEngine } from "../engine/dump-ledger-engine.js";
import type { DumpLedgerProjection, DumpProjection, SymbolArtifactProjection } from "../engine/projection.js";
import type { SymbolVault, Vault, VaultReader } from "../vault/vault.js";
import {
  dumpEntryName,
  serializeExportManifest,
  symbolEntryName,
  type ExportManifest,
  type ExportManifestDump,
  type ExportManifestSkipped,
  type ExportManifestSymbol,
} from "./manifest.js";
import { createTarWriter, type TarSink, type TarWriter } from "./tar.js";

const BUNDLE_PART_NAME = "bundle.tar.part";
const BUNDLE_FINAL_NAME = "bundle.tar";
const LEDGER_COPY_NAME = "ledger.sqlite";
const STREAM_CHUNK_SIZE = 1024 * 1024;
const EXPORT_ID_PATTERN = /^export_[0-9a-f]{32}$/;
const DEFAULT_GENERATOR_VERSION = "0.1.0";
/** Mirrors MAX_TRANSFER_ERROR_LENGTH in @dump-ledger/http-contracts (kept local: no runtime contract import here). */
const MAX_ERROR_LENGTH = 2000;

/** A bundle being written: byte sink plus seal/discard for the atomic rename protocol. */
export interface BundleTarget {
  readonly sink: TarSink;
  /** fsync the part file, rename it onto the final path, fsync the directory. */
  seal(): void;
  /** Close and remove the partial bundle; never called after seal(). */
  discard(): void;
}

/** Test hook: replace the file-backed bundle target (e.g. a sink that fails mid-copy). */
export type BundleTargetFactory = (paths: { readonly partPath: string; readonly finalPath: string }) => BundleTarget;

export interface ExportBundleOptions {
  readonly engine: DumpLedgerEngine;
  readonly vault: Vault;
  readonly exportsDir: string;
  /** Bundle identifier and bundle directory name; defaults to `export_<32 hex chars>` from crypto randomness. */
  readonly exportId?: string;
  /** Manifest createdAt and summary timestamp; defaults to the current time. Must be a canonical ISO timestamp. */
  readonly createdAt?: string;
  /** generator.version written into the manifest; informational only (schemaMigrations is the compat gate). */
  readonly generatorVersion?: string;
  /**
   * Opt-in symbol payload (design milestone 3, default false): when true the
   * bundle carries one entry per registered symbol artifact whose exact
   * (debugFile, debugId) identity a declared dump's stored inspection facts
   * reference. Omitted/false is byte-identical to the pre-flag pipeline.
   */
  readonly includeSymbols?: boolean;
  readonly targetFactory?: BundleTargetFactory;
}

function syncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    fsyncSync(descriptor);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function assertRealDirectory(path: string): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new DumpLedgerError("storage_unavailable", "exports directory is not a real directory");
}

function writeAll(descriptor: number, bytes: Uint8Array): void {
  let written = 0;
  while (written < bytes.byteLength) {
    const count = writeSync(descriptor, bytes, written, bytes.byteLength - written);
    if (count === 0) throw new DumpLedgerError("storage_unavailable", "bundle write made no progress");
    written += count;
  }
}

/** The default file-backed bundle target (fsync + atomic rename); exposed for fault-injecting wrappers. */
export function fileBundleTarget(paths: { readonly partPath: string; readonly finalPath: string }): BundleTarget {
  const descriptor = openSync(paths.partPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let closed = false;
  return {
    sink: { write: bytes => writeAll(descriptor, bytes) },
    seal(): void {
      fsyncSync(descriptor);
      closeSync(descriptor);
      closed = true;
      renameSync(paths.partPath, paths.finalPath);
      syncDirectory(dirname(paths.finalPath));
    },
    discard(): void {
      if (!closed) {
        closeSync(descriptor);
        closed = true;
      }
      rmSync(paths.partPath, { force: true });
    },
  };
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH - 3)}...` : message;
}

function writeBytesEntry(writer: TarWriter, name: string, bytes: Uint8Array): void {
  const entry = writer.addEntry(name, BigInt(bytes.byteLength));
  entry.append(bytes);
  entry.finish();
}

function writeFileEntry(writer: TarWriter, name: string, path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const size = fstatSync(descriptor, { bigint: true }).size;
    const entry = writer.addEntry(name, size);
    const buffer = new Uint8Array(STREAM_CHUNK_SIZE);
    let position = 0n;
    while (position < size) {
      const wanted = Number(size - position < BigInt(STREAM_CHUNK_SIZE) ? size - position : BigInt(STREAM_CHUNK_SIZE));
      const count = readSync(descriptor, buffer, 0, wanted, position);
      if (count !== wanted) throw new DumpLedgerError("storage_unavailable", `short read while streaming ${name} into the bundle`);
      entry.append(buffer.subarray(0, count));
      position += BigInt(count);
    }
    entry.finish();
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Reads the stored inspection facts of the declared dumps from the ledger
 * copy (the same consistent snapshot the bundle's SQLite entry preserves).
 * Only used on the opt-in symbol path; a bundle without symbols never reads
 * these columns.
 */
function readStoredFacts(copyPath: string): ReadonlyMap<string, Readonly<Record<string, unknown>>> {
  const facts = new Map<string, Readonly<Record<string, unknown>>>();
  const database = new BetterSqlite3(copyPath, { readonly: true });
  try {
    const rows = database.prepare("SELECT dump_id, inspection_facts_json FROM dumps WHERE inspection_facts_json IS NOT NULL").all() as Array<{ dump_id: string; inspection_facts_json: string }>;
    for (const row of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.inspection_facts_json);
      } catch {
        continue; // stored facts are best-effort metadata; an unreadable row matches nothing
      }
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        facts.set(row.dump_id, parsed as Readonly<Record<string, unknown>>);
      }
    }
  } finally {
    database.close();
  }
  return facts;
}

/** The exact, case-sensitive (debugFile, debugId) identity join key. */
function identityKey(debugFile: string, debugId: string): string {
  return `${debugFile}\u0000${debugId}`;
}

/** Collects the debug identities one dump's stored facts reference (the parallel inspection-facts field names are pinned). */
function referencedIdentities(facts: Readonly<Record<string, unknown>> | undefined): readonly string[] {
  const modules = facts?.["modules"];
  if (!Array.isArray(modules)) return [];
  const identities: string[] = [];
  for (const module of modules) {
    if (typeof module !== "object" || module === null || Array.isArray(module)) continue;
    const record = module as Readonly<Record<string, unknown>>;
    const debugFile = record["debugFile"];
    const debugId = record["debugId"];
    if (typeof debugFile !== "string" || typeof debugId !== "string" || debugFile.length === 0 || debugId.length === 0) continue;
    identities.push(identityKey(debugFile, debugId));
  }
  return identities;
}

/**
 * Selects the registered symbol artifacts the bundle will carry: a declared
 * dump's facts reference the artifact's exact identity (case-sensitive), and
 * every matched artifact is included once (deterministic order by artifact
 * id, mirroring the dump ordering).
 */
function selectSymbols(artifacts: readonly SymbolArtifactProjection[], factsByDump: ReadonlyMap<string, Readonly<Record<string, unknown>>>, declared: readonly string[]): readonly ExportManifestSymbol[] {
  const referenced = new Set<string>();
  for (const dumpId of declared) {
    for (const identity of referencedIdentities(factsByDump.get(dumpId))) referenced.add(identity);
  }
  return artifacts
    .filter(artifact => artifact.kind === "pdb" && referenced.has(identityKey(artifact.debugFile, artifact.debugId)))
    .sort((a, b) => (a.artifactId < b.artifactId ? -1 : a.artifactId > b.artifactId ? 1 : 0))
    .map(artifact => ({
      artifactId: artifact.artifactId,
      debugFile: artifact.debugFile,
      debugId: artifact.debugId,
      kind: "pdb" as const,
      byteSize: artifact.byteSize,
      sha256: artifact.sha256,
      entry: symbolEntryName(artifact.artifactId),
      ...(artifact.product === null ? {} : { product: artifact.product }),
      ...(artifact.version === null ? {} : { version: artifact.version }),
      ...(artifact.arch === null ? {} : { arch: artifact.arch }),
    }));
}

function raceFailure(dumpId: string, detail: string, cause?: unknown): DumpLedgerError {
  return new DumpLedgerError("storage_unavailable", `retryable: vault bytes for ${dumpId} ${detail}; rerun the export`, cause === undefined ? undefined : { cause });
}

/**
 * Streams one available dump through the vault reader. Any sign that the
 * bytes vanished or changed mid-copy aborts the whole export (race policy).
 */
function writeDumpEntry(writer: TarWriter, vault: Vault, dump: DumpProjection): void {
  const expectedSize = dump.byteSize;
  if (expectedSize === null || dump.sha256 === null) throw new DumpLedgerError("integrity_failure", `available dump ${dump.dumpId} has no recorded size or hash`);
  let reader: VaultReader;
  try {
    reader = vault.openImmutable(dump.dumpId);
  } catch (error) {
    throw raceFailure(dump.dumpId, "vanished before the export could open them", error);
  }
  try {
    if (reader.size !== expectedSize) throw raceFailure(dump.dumpId, `changed size mid-export (recorded ${expectedSize}, found ${reader.size})`);
    const entry = writer.addEntry(dumpEntryName(dump.dumpId), expectedSize);
    let position = 0n;
    while (position < expectedSize) {
      const wanted = Number(expectedSize - position < BigInt(STREAM_CHUNK_SIZE) ? expectedSize - position : BigInt(STREAM_CHUNK_SIZE));
      const chunk = reader.read(position, wanted);
      if (chunk.byteLength !== wanted) throw raceFailure(dump.dumpId, "vanished mid-copy");
      entry.append(chunk);
      position += BigInt(chunk.byteLength);
    }
    entry.finish();
  } finally {
    reader.close();
  }
}

/**
 * Streams one carried symbol artifact through the symbol vault. Like dump
 * bytes, a vanished/changed artifact aborts the whole export (retryable): a
 * bundle missing a manifest entry is never sealed.
 */
function writeSymbolEntry(writer: TarWriter, symbolVault: SymbolVault, symbol: ExportManifestSymbol): void {
  const reader = symbolVault.openSymbol(symbol.artifactId);
  if (reader === undefined) throw raceFailure(symbol.artifactId, "vanished before the export could open them");
  try {
    if (reader.size !== symbol.byteSize) throw raceFailure(symbol.artifactId, `changed size mid-export (recorded ${symbol.byteSize}, found ${reader.size})`);
    const entry = writer.addEntry(symbol.entry, symbol.byteSize);
    let position = 0n;
    while (position < symbol.byteSize) {
      const wanted = Number(symbol.byteSize - position < BigInt(STREAM_CHUNK_SIZE) ? symbol.byteSize - position : BigInt(STREAM_CHUNK_SIZE));
      const chunk = reader.read(position, wanted);
      if (chunk.byteLength !== wanted) throw raceFailure(symbol.artifactId, "vanished mid-copy");
      entry.append(chunk);
      position += BigInt(chunk.byteLength);
    }
    entry.finish();
  } finally {
    reader.close();
  }
}

function readSchemaMigrations(ledgerCopyPath: string): number {
  const database = new BetterSqlite3(ledgerCopyPath, { readonly: true });
  try {
    const row = database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as { version: number | bigint };
    return Number(row.version);
  } finally {
    database.close();
  }
}

function select(snapshot: DumpLedgerProjection, fingerprint: string, createdAt: string, generatorVersion: string, schemaMigrations: number, symbols: readonly ExportManifestSymbol[] | undefined): ExportManifest {
  const dumps: ExportManifestDump[] = [];
  const skipped: ExportManifestSkipped[] = [];
  for (const dump of snapshot.dumps) {
    if (dump.phase === "available") {
      if (dump.byteSize === null || dump.sha256 === null) throw new DumpLedgerError("integrity_failure", `available dump ${dump.dumpId} has no recorded size or hash`);
      dumps.push({ dumpId: dump.dumpId, caseId: dump.caseId, phase: "available", originalName: dump.originalName, byteSize: dump.byteSize, sha256: dump.sha256, entry: dumpEntryName(dump.dumpId) });
    } else if (dump.phase === "rejected" || dump.phase === "deleted") {
      dumps.push({ dumpId: dump.dumpId, caseId: dump.caseId, phase: dump.phase, originalName: dump.originalName, byteSize: dump.byteSize, sha256: dump.sha256, entry: null });
    } else {
      skipped.push({ dumpId: dump.dumpId, phase: dump.phase, reason: "not-stable" });
    }
  }
  dumps.sort((a, b) => (a.dumpId < b.dumpId ? -1 : a.dumpId > b.dumpId ? 1 : 0));
  skipped.sort((a, b) => (a.dumpId < b.dumpId ? -1 : a.dumpId > b.dumpId ? 1 : 0));
  const exported = new Set(dumps.map(dump => dump.dumpId));
  const auditEvents = snapshot.auditEvents.filter(event => event.dumpId === null || exported.has(event.dumpId)).length;
  return {
      schema: "dump-ledger.export-manifest/v1",
      createdAt,
      generator: { version: generatorVersion, schemaMigrations },
      grantKeyFingerprint: fingerprint,
      counts: {
        customers: snapshot.customers.length,
        cases: snapshot.cases.length,
        grants: snapshot.grants.length,
        dumps: dumps.length,
        auditEvents,
        ...(symbols === undefined ? {} : { symbols: symbols.length }),
      },
      skipped,
      dumps,
      ...(symbols === undefined ? {} : { symbols }),
  };
}

/**
 * An open export: snapshot, ledger backup, and selection are frozen at
 * creation; run() streams the bundle and seals (or fails) exactly once.
 */
export interface ExportSession {
  readonly exportId: string;
  readonly createdAt: string;
  readonly exportDir: string;
  /** The computed selection: which dumps the bundle promises, which it carries as tombstones, which it skips. */
  readonly manifest: ExportManifest;
  /** The consistent snapshot the selection was computed from. */
  readonly snapshot: DumpLedgerProjection;
  /** True once run() has settled (sealed or failed); a settled session cannot run again. */
  readonly settled: boolean;
  /**
   * Streams the bundle and seals it. Operational failures (including the
   * mid-copy purge race) return a failed summary after removing the work
   * directory, matching the one-shot exportBundle contract.
   */
  run(): Promise<ExportSummary>;
  /** Removes the work directory without sealing; only valid before run(). */
  discard(): void;
}

/** A validated export target: the work directory exists and the identifiers are fixed. */
export interface PreparedExport {
  readonly exportsDir: string;
  readonly exportId: string;
  readonly createdAt: string;
  readonly exportDir: string;
  readonly ledgerCopyPath: string;
}

/**
 * Validates options and creates the work directory. Programmer errors (bad
 * identifiers, bad timestamps, a colliding export directory) throw, exactly
 * like the one-shot exportBundle.
 */
export function prepareExport(options: ExportBundleOptions): PreparedExport {
  const exportsDir = resolve(options.exportsDir);
  mkdirSync(exportsDir, { recursive: true, mode: 0o700 });
  assertRealDirectory(exportsDir);
  const exportId = options.exportId ?? `export_${randomBytes(16).toString("hex")}`;
  if (!EXPORT_ID_PATTERN.test(exportId)) throw new RangeError(`invalid export identifier: ${exportId}`);
  const createdAt = options.createdAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) throw new RangeError(`createdAt must be a canonical ISO timestamp: ${createdAt}`);
  const exportDir = join(exportsDir, exportId);
  try {
    mkdirSync(exportDir, { mode: 0o700 });
  } catch (error) {
    throw new DumpLedgerError("invalid_input", `export ${exportId} already exists`, { cause: error });
  }
  return { exportsDir, exportId, createdAt, exportDir, ledgerCopyPath: join(exportDir, LEDGER_COPY_NAME) };
}

/**
 * Takes the consistent snapshot + ledger backup and computes the selection.
 * Operational failures remove the work directory before propagating.
 */
export async function openPreparedExport(prepared: PreparedExport, options: ExportBundleOptions): Promise<ExportSession> {
  const { exportId, createdAt, exportDir, ledgerCopyPath } = prepared;
  let snapshot: DumpLedgerProjection;
  let manifest: ExportManifest;
  try {
    snapshot = options.engine.snapshot();
    await options.engine.backup(ledgerCopyPath);
    const schemaMigrations = readSchemaMigrations(ledgerCopyPath);
    // The opt-in symbol path joins the backup's stored facts against the
    // snapshot's registered artifacts; without the flag nothing is read and
    // the manifest is byte-identical to the pre-flag output.
    let symbols: readonly ExportManifestSymbol[] | undefined;
    if (options.includeSymbols === true) {
      const declaredIds = snapshot.dumps
        .filter(dump => dump.phase === "available" || dump.phase === "rejected" || dump.phase === "deleted")
        .map(dump => dump.dumpId as string);
      symbols = selectSymbols(snapshot.symbols, readStoredFacts(ledgerCopyPath), declaredIds);
    }
    manifest = select(snapshot, options.engine.grantKeyFingerprint(), createdAt, options.generatorVersion ?? DEFAULT_GENERATOR_VERSION, schemaMigrations, symbols);
  } catch (error) {
    rmSync(exportDir, { recursive: true, force: true });
    throw error;
  }

  let settled = false;
  const session: ExportSession = {
    exportId,
    createdAt,
    exportDir,
    manifest,
    snapshot,
    get settled() { return settled; },
    async run(): Promise<ExportSummary> {
      if (settled) throw new DumpLedgerError("invalid_transition", `export ${exportId} has already settled`);
      settled = true;
      let target: BundleTarget | undefined;
      try {
        const manifestBytes = serializeExportManifest(manifest);
        const partPath = join(exportDir, BUNDLE_PART_NAME);
        const finalPath = join(exportDir, BUNDLE_FINAL_NAME);
        target = (options.targetFactory ?? fileBundleTarget)({ partPath, finalPath });
        const writer = createTarWriter(target.sink);
        writeBytesEntry(writer, "manifest.json", manifestBytes);
        writeFileEntry(writer, "ledger.sqlite", ledgerCopyPath);
        const available = snapshot.dumps
          .filter(dump => dump.phase === "available")
          .sort((a, b) => (a.dumpId < b.dumpId ? -1 : a.dumpId > b.dumpId ? 1 : 0));
        for (const dump of available) writeDumpEntry(writer, options.vault, dump);
        const symbols = manifest.symbols;
        if (symbols !== undefined && symbols.length > 0) {
          const candidate = options.vault as Partial<SymbolVault>;
          if (typeof candidate.openSymbol !== "function") throw new DumpLedgerError("invalid_input", "symbol storage is not configured on this vault");
          const symbolVault = candidate as SymbolVault;
          for (const symbol of symbols) writeSymbolEntry(writer, symbolVault, symbol);
        }
        writer.finish();
        target.seal();
        target = undefined;
        try {
          rmSync(ledgerCopyPath, { force: true });
        } catch {
          // best effort: the sealed bundle is authoritative; a leftover temp copy is removed with the export.
        }
        const byteSize = statSync(finalPath, { bigint: true }).size.toString();
        return { exportId, status: "sealed", createdAt, byteSize, error: null };
      } catch (error) {
        if (target !== undefined) {
          try {
            target.discard();
          } catch {
            // best effort: the work directory is removed below regardless.
          }
        }
        rmSync(exportDir, { recursive: true, force: true });
        return { exportId, status: "failed", createdAt, byteSize: null, error: errorMessage(error) };
      }
    },
    discard(): void {
      if (settled) return;
      settled = true;
      rmSync(exportDir, { recursive: true, force: true });
    },
  };
  return session;
}

/**
 * Opens an export session in one step: prepare (validates, throws on bad
 * options) plus snapshot/backup/selection (throws operational errors after
 * cleaning up the work directory).
 */
export async function createExportSession(options: ExportBundleOptions): Promise<ExportSession> {
  return openPreparedExport(prepareExport(options), options);
}

/**
 * Runs one export. Operational failures (including the mid-copy purge race)
 * return a failed summary after removing the work directory; only programmer
 * errors (bad options) throw.
 */
export async function exportBundle(options: ExportBundleOptions): Promise<ExportSummary> {
  const prepared = prepareExport(options);
  let session: ExportSession;
  try {
    session = await openPreparedExport(prepared, options);
  } catch (error) {
    return { exportId: prepared.exportId, status: "failed", createdAt: prepared.createdAt, byteSize: null, error: errorMessage(error) };
  }
  return session.run();
}
