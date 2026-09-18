import { DumpLedgerError } from "../domain/errors.js";
import type { DumpId, SymbolArtifactId } from "../domain/ids.js";
import type { SymbolVault, Vault, VaultPresence, VaultReader } from "./vault.js";

interface StagingObject { readonly chunks: Uint8Array[]; readonly createdAt: number; open: boolean }
function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

export class MemoryVault implements Vault, SymbolVault {
  private readonly staging = new Map<DumpId, StagingObject>();
  private readonly objects = new Map<DumpId, Uint8Array>();
  constructor(private readonly now: () => number = Date.now) {}
  createStaging(dumpId: DumpId): void {
    if (this.staging.has(dumpId) || this.objects.has(dumpId)) throw new DumpLedgerError("integrity_failure", "dump storage already exists");
    this.staging.set(dumpId, { chunks: [], createdAt: this.now(), open: true });
  }
  append(dumpId: DumpId, bytes: Uint8Array): void {
    const staging = this.staging.get(dumpId);
    if (staging === undefined || !staging.open) throw new DumpLedgerError("invalid_transition", "staging object is not open");
    staging.chunks.push(Uint8Array.from(bytes));
  }
  syncAndClose(dumpId: DumpId): void {
    const staging = this.staging.get(dumpId);
    if (staging === undefined) throw new DumpLedgerError("storage_unavailable", "staging object is missing");
    staging.open = false;
  }
  promote(dumpId: DumpId): void {
    const staging = this.staging.get(dumpId);
    if (staging === undefined) {
      if (this.objects.has(dumpId)) return;
      throw new DumpLedgerError("storage_unavailable", "staging object is missing");
    }
    if (staging.open) throw new DumpLedgerError("invalid_transition", "staging object is not sealed");
    if (this.objects.has(dumpId)) throw new DumpLedgerError("integrity_failure", "staging and vault objects both exist");
    this.objects.set(dumpId, concatenate(staging.chunks));
    this.staging.delete(dumpId);
  }
  openImmutable(dumpId: DumpId): VaultReader {
    const object = this.objects.get(dumpId);
    if (object === undefined) throw new DumpLedgerError("storage_unavailable", "vault object is missing");
    const snapshot = Uint8Array.from(object);
    let closed = false;
    return {
      size: BigInt(snapshot.byteLength),
      read(position, length) {
        if (closed) throw new DumpLedgerError("invalid_transition", "vault reader is closed");
        if (position < 0n || length < 0 || position > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("invalid vault read range");
        return snapshot.slice(Number(position), Number(position) + length);
      },
      close() { closed = true; },
    };
  }
  removeStaging(dumpId: DumpId): void { this.staging.delete(dumpId); }
  remove(dumpId: DumpId): void { this.staging.delete(dumpId); this.objects.delete(dumpId); }
  inspectPresence(dumpId: DumpId): VaultPresence { return { staging: this.staging.has(dumpId), vault: this.objects.has(dumpId) }; }
  listStagingIds(): readonly DumpId[] { return [...this.staging.keys()].sort(); }
  stagingModifiedAt(dumpId: DumpId): number | null { return this.staging.get(dumpId)?.createdAt ?? null; }
  /* ---------------- symbol artifact namespace (docs/symbols-design.md) --- */

  private readonly symbolStaging = new Map<SymbolArtifactId, StagingObject>();
  private readonly symbolObjects = new Map<SymbolArtifactId, Uint8Array>();

  createSymbolStaging(artifactId: SymbolArtifactId): void {
    if (this.symbolStaging.has(artifactId) || this.symbolObjects.has(artifactId)) throw new DumpLedgerError("integrity_failure", "symbol storage already exists");
    this.symbolStaging.set(artifactId, { chunks: [], createdAt: this.now(), open: true });
  }
  appendSymbol(artifactId: SymbolArtifactId, bytes: Uint8Array): void {
    const staging = this.symbolStaging.get(artifactId);
    if (staging === undefined || !staging.open) throw new DumpLedgerError("invalid_transition", "symbol staging object is not open");
    staging.chunks.push(Uint8Array.from(bytes));
  }
  syncAndCloseSymbol(artifactId: SymbolArtifactId): void {
    const staging = this.symbolStaging.get(artifactId);
    if (staging === undefined) throw new DumpLedgerError("storage_unavailable", "symbol staging object is missing");
    staging.open = false;
  }
  promoteSymbol(artifactId: SymbolArtifactId): void {
    const staging = this.symbolStaging.get(artifactId);
    if (staging === undefined) {
      if (this.symbolObjects.has(artifactId)) return;
      throw new DumpLedgerError("storage_unavailable", "symbol staging object is missing");
    }
    if (staging.open) throw new DumpLedgerError("invalid_transition", "symbol staging object is not sealed");
    if (this.symbolObjects.has(artifactId)) throw new DumpLedgerError("integrity_failure", "symbol staging and vault objects both exist");
    this.symbolObjects.set(artifactId, concatenate(staging.chunks));
    this.symbolStaging.delete(artifactId);
  }
  openSymbolStagingReader(artifactId: SymbolArtifactId): VaultReader | undefined {
    const staging = this.symbolStaging.get(artifactId);
    if (staging === undefined) return undefined;
    if (staging.open) throw new DumpLedgerError("invalid_transition", "symbol staging object is not sealed");
    const snapshot = concatenate(staging.chunks);
    let closed = false;
    return {
      size: BigInt(snapshot.byteLength),
      read(position, length) {
        if (closed) throw new DumpLedgerError("invalid_transition", "symbol staging reader is closed");
        if (position < 0n || position > BigInt(snapshot.byteLength) || length < 0) throw new RangeError("invalid symbol read range");
        const start = Number(position);
        return snapshot.subarray(start, Math.min(start + length, snapshot.byteLength));
      },
      close() { closed = true; },
    };
  }
  openSymbol(artifactId: SymbolArtifactId): VaultReader | undefined {
    const object = this.symbolObjects.get(artifactId);
    if (object === undefined) return undefined;
    const snapshot = Uint8Array.from(object);
    let closed = false;
    return {
      size: BigInt(snapshot.byteLength),
      read(position, length) {
        if (closed) throw new DumpLedgerError("invalid_transition", "symbol reader is closed");
        if (position < 0n || position > BigInt(snapshot.byteLength) || length < 0) throw new RangeError("invalid symbol read range");
        const start = Number(position);
        return snapshot.subarray(start, Math.min(start + length, snapshot.byteLength));
      },
      close() { closed = true; },
    };
  }
  removeSymbolStaging(artifactId: SymbolArtifactId): void { this.symbolStaging.delete(artifactId); }
  removeSymbol(artifactId: SymbolArtifactId): void { this.symbolStaging.delete(artifactId); this.symbolObjects.delete(artifactId); }
  symbolPresence(artifactId: SymbolArtifactId): VaultPresence { return { staging: this.symbolStaging.has(artifactId), vault: this.symbolObjects.has(artifactId) }; }
}
