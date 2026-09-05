import { DumpLedgerError } from "../domain/errors.js";
import type { DumpId } from "../domain/ids.js";
import type { Vault, VaultPresence, VaultReader } from "./vault.js";

interface StagingObject { readonly chunks: Uint8Array[]; readonly createdAt: number; open: boolean }
function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

export class MemoryVault implements Vault {
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
}
