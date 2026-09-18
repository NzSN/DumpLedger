import { closeSync, constants, existsSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { DumpLedgerError } from "../domain/errors.js";
import { parseDumpId, type DumpId, type SymbolArtifactId } from "../domain/ids.js";
import type { SymbolVault, Vault, VaultPresence, VaultReader } from "./vault.js";

function syncDirectory(path: string): void {
  let descriptor: number | undefined;
  try { descriptor = openSync(path, "r"); fsyncSync(descriptor); }
  catch (error) { if (process.platform !== "win32") throw error; }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}
function assertRealDirectory(path: string): void {
  const info = lstatSync(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new DumpLedgerError("storage_unavailable", "vault directory is not a real directory");
}

export class FilesystemVault implements Vault, SymbolVault {
  readonly root: string;
  readonly stagingRoot: string;
  readonly vaultRoot: string;
  readonly symbolsStagingRoot: string;
  readonly symbolsRoot: string;
  private readonly openStaging = new Map<DumpId, number>();
  private readonly openSymbolStaging = new Map<SymbolArtifactId, number>();
  constructor(root: string) {
    this.root = resolve(root);
    this.stagingRoot = join(this.root, "staging");
    this.vaultRoot = join(this.root, "vault");
    this.symbolsStagingRoot = join(this.root, "symbols-staging");
    this.symbolsRoot = join(this.root, "symbols");
    mkdirSync(this.stagingRoot, { mode: 0o700, recursive: true });
    mkdirSync(this.vaultRoot, { mode: 0o700, recursive: true });
    mkdirSync(this.symbolsStagingRoot, { mode: 0o700, recursive: true });
    mkdirSync(this.symbolsRoot, { mode: 0o700, recursive: true });
    for (const path of [this.root, this.stagingRoot, this.vaultRoot, this.symbolsStagingRoot, this.symbolsRoot]) assertRealDirectory(path);
    if (statSync(this.stagingRoot).dev !== statSync(this.vaultRoot).dev) throw new DumpLedgerError("storage_unavailable", "staging and vault roots must share a filesystem");
    if (statSync(this.symbolsStagingRoot).dev !== statSync(this.symbolsRoot).dev) throw new DumpLedgerError("storage_unavailable", "symbol staging and symbol roots must share a filesystem");
  }
  createStaging(dumpId: DumpId): void {
    const descriptor = openSync(this.stagingPath(dumpId), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    this.openStaging.set(dumpId, descriptor);
  }
  append(dumpId: DumpId, bytes: Uint8Array): void {
    const descriptor = this.openStaging.get(dumpId);
    if (descriptor === undefined) throw new DumpLedgerError("invalid_transition", "staging object is not open");
    let written = 0;
    while (written < bytes.byteLength) {
      const count = writeSync(descriptor, bytes, written, bytes.byteLength - written);
      if (count === 0) throw new DumpLedgerError("storage_unavailable", "staging write made no progress");
      written += count;
    }
  }
  syncAndClose(dumpId: DumpId): void {
    const descriptor = this.openStaging.get(dumpId);
    if (descriptor === undefined) {
      if (existsSync(this.stagingPath(dumpId))) return;
      throw new DumpLedgerError("storage_unavailable", "staging object is missing");
    }
    fsyncSync(descriptor); closeSync(descriptor); this.openStaging.delete(dumpId);
  }
  promote(dumpId: DumpId): void {
    if (this.openStaging.has(dumpId)) throw new DumpLedgerError("invalid_transition", "staging object is not sealed");
    const staging = this.stagingPath(dumpId), objectDirectory = this.objectDirectory(dumpId), object = this.objectPath(dumpId);
    if (!existsSync(staging)) {
      if (existsSync(object)) return;
      throw new DumpLedgerError("storage_unavailable", "staging object is missing");
    }
    if (existsSync(object)) throw new DumpLedgerError("integrity_failure", "staging and vault objects both exist");
    mkdirSync(objectDirectory, { mode: 0o700, recursive: true });
    assertRealDirectory(objectDirectory);
    renameSync(staging, object); syncDirectory(objectDirectory); syncDirectory(this.vaultRoot);
  }
  openImmutable(dumpId: DumpId): VaultReader {
    assertRealDirectory(this.objectDirectory(dumpId));
    const descriptor = openSync(this.objectPath(dumpId), constants.O_RDONLY | constants.O_NOFOLLOW);
    const fileInfo = fstatSync(descriptor, { bigint: true });
    if (!fileInfo.isFile()) { closeSync(descriptor); throw new DumpLedgerError("storage_unavailable", "vault object is not a regular file"); }
    let closed = false;
    return {
      size: fileInfo.size,
      read(position, length) {
        if (closed) throw new DumpLedgerError("invalid_transition", "vault reader is closed");
        if (position < 0n || position > BigInt(Number.MAX_SAFE_INTEGER) || length < 0) throw new RangeError("invalid vault read range");
        const buffer = Buffer.alloc(length);
        const count = readSync(descriptor, buffer, 0, length, Number(position));
        return Uint8Array.from(buffer.subarray(0, count));
      },
      close() { if (!closed) closeSync(descriptor); closed = true; },
    };
  }
  removeStaging(dumpId: DumpId): void {
    const descriptor = this.openStaging.get(dumpId);
    if (descriptor !== undefined) { closeSync(descriptor); this.openStaging.delete(dumpId); }
    rmSync(this.stagingPath(dumpId), { force: true }); syncDirectory(this.stagingRoot);
  }
  remove(dumpId: DumpId): void { this.removeStaging(dumpId); rmSync(this.objectDirectory(dumpId), { force: true, recursive: true }); syncDirectory(this.vaultRoot); }
  inspectPresence(dumpId: DumpId): VaultPresence { return { staging: existsSync(this.stagingPath(dumpId)), vault: existsSync(this.objectPath(dumpId)) }; }
  listStagingIds(): readonly DumpId[] {
    return readdirSync(this.stagingRoot).filter(entry => entry.endsWith(".part")).flatMap(entry => {
      try { return [parseDumpId(entry.slice(0, -5))]; } catch { return []; }
    }).sort();
  }
  stagingModifiedAt(dumpId: DumpId): number | null {
    try { return lstatSync(this.stagingPath(dumpId)).mtimeMs; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  private stagingPath(dumpId: DumpId): string { return join(this.stagingRoot, `${basename(dumpId)}.part`); }
  private objectDirectory(dumpId: DumpId): string { return join(this.vaultRoot, basename(dumpId)); }
  private objectPath(dumpId: DumpId): string { return join(this.objectDirectory(dumpId), "original.dmp"); }
  /* ---------------- symbol artifact namespace (docs/symbols-design.md) --- */

  private symbolStagingPath(artifactId: SymbolArtifactId): string { return join(this.symbolsStagingRoot, `${artifactId}.part`); }
  private symbolObjectDirectory(artifactId: SymbolArtifactId): string { return join(this.symbolsRoot, artifactId); }
  private symbolObjectPath(artifactId: SymbolArtifactId): string { return join(this.symbolObjectDirectory(artifactId), "artifact.bin"); }

  createSymbolStaging(artifactId: SymbolArtifactId): void {
    const descriptor = openSync(this.symbolStagingPath(artifactId), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    this.openSymbolStaging.set(artifactId, descriptor);
  }
  appendSymbol(artifactId: SymbolArtifactId, bytes: Uint8Array): void {
    const descriptor = this.openSymbolStaging.get(artifactId);
    if (descriptor === undefined) throw new DumpLedgerError("invalid_transition", "symbol staging object is not open");
    let written = 0;
    while (written < bytes.byteLength) {
      const count = writeSync(descriptor, bytes, written, bytes.byteLength - written);
      if (count === 0) throw new DumpLedgerError("storage_unavailable", "symbol staging write made no progress");
      written += count;
    }
  }
  syncAndCloseSymbol(artifactId: SymbolArtifactId): void {
    const descriptor = this.openSymbolStaging.get(artifactId);
    if (descriptor === undefined) {
      if (existsSync(this.symbolStagingPath(artifactId))) return;
      throw new DumpLedgerError("storage_unavailable", "symbol staging object is missing");
    }
    fsyncSync(descriptor); closeSync(descriptor); this.openSymbolStaging.delete(artifactId);
  }
  promoteSymbol(artifactId: SymbolArtifactId): void {
    if (this.openSymbolStaging.has(artifactId)) throw new DumpLedgerError("invalid_transition", "symbol staging object is not sealed");
    const staging = this.symbolStagingPath(artifactId), objectDirectory = this.symbolObjectDirectory(artifactId), object = this.symbolObjectPath(artifactId);
    if (!existsSync(staging)) {
      if (existsSync(object)) return;
      throw new DumpLedgerError("storage_unavailable", "symbol staging object is missing");
    }
    if (existsSync(object)) throw new DumpLedgerError("integrity_failure", "symbol staging and vault objects both exist");
    mkdirSync(objectDirectory, { mode: 0o700, recursive: true });
    assertRealDirectory(objectDirectory);
    renameSync(staging, object); syncDirectory(objectDirectory); syncDirectory(this.symbolsRoot);
  }
  openSymbolStagingReader(artifactId: SymbolArtifactId): VaultReader | undefined {
    if (this.openSymbolStaging.has(artifactId)) throw new DumpLedgerError("invalid_transition", "symbol staging object is not sealed");
    if (!existsSync(this.symbolStagingPath(artifactId))) return undefined;
    const descriptor = openSync(this.symbolStagingPath(artifactId), constants.O_RDONLY | constants.O_NOFOLLOW);
    const fileInfo = fstatSync(descriptor, { bigint: true });
    if (!fileInfo.isFile()) { closeSync(descriptor); throw new DumpLedgerError("storage_unavailable", "symbol staging object is not a regular file"); }
    let closed = false;
    return {
      size: fileInfo.size,
      read(position, length) {
        if (closed) throw new DumpLedgerError("invalid_transition", "symbol staging reader is closed");
        if (position < 0n || position > BigInt(Number.MAX_SAFE_INTEGER) || length < 0) throw new RangeError("invalid symbol read range");
        const buffer = Buffer.alloc(length);
        const count = readSync(descriptor, buffer, 0, length, Number(position));
        return Uint8Array.from(buffer.subarray(0, count));
      },
      close() { if (!closed) closeSync(descriptor); closed = true; },
    };
  }
  openSymbol(artifactId: SymbolArtifactId): VaultReader | undefined {
    if (!existsSync(this.symbolObjectPath(artifactId))) return undefined;
    assertRealDirectory(this.symbolObjectDirectory(artifactId));
    const descriptor = openSync(this.symbolObjectPath(artifactId), constants.O_RDONLY | constants.O_NOFOLLOW);
    const fileInfo = fstatSync(descriptor, { bigint: true });
    if (!fileInfo.isFile()) { closeSync(descriptor); throw new DumpLedgerError("storage_unavailable", "symbol object is not a regular file"); }
    let closed = false;
    return {
      size: fileInfo.size,
      read(position, length) {
        if (closed) throw new DumpLedgerError("invalid_transition", "symbol reader is closed");
        if (position < 0n || position > BigInt(Number.MAX_SAFE_INTEGER) || length < 0) throw new RangeError("invalid symbol read range");
        const buffer = Buffer.alloc(length);
        const count = readSync(descriptor, buffer, 0, length, Number(position));
        return Uint8Array.from(buffer.subarray(0, count));
      },
      close() { if (!closed) closeSync(descriptor); closed = true; },
    };
  }
  removeSymbolStaging(artifactId: SymbolArtifactId): void {
    const descriptor = this.openSymbolStaging.get(artifactId);
    if (descriptor !== undefined) { closeSync(descriptor); this.openSymbolStaging.delete(artifactId); }
    rmSync(this.symbolStagingPath(artifactId), { force: true }); syncDirectory(this.symbolsStagingRoot);
  }
  removeSymbol(artifactId: SymbolArtifactId): void { this.removeSymbolStaging(artifactId); rmSync(this.symbolObjectDirectory(artifactId), { force: true, recursive: true }); syncDirectory(this.symbolsRoot); }
  symbolPresence(artifactId: SymbolArtifactId): VaultPresence { return { staging: existsSync(this.symbolStagingPath(artifactId)), vault: existsSync(this.symbolObjectPath(artifactId)) }; }
}
