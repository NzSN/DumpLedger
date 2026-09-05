import type { DumpId } from "../domain/ids.js";
export interface VaultReader { readonly size: bigint; read(position: bigint, length: number): Uint8Array; close(): void }
export interface VaultPresence { readonly staging: boolean; readonly vault: boolean }
export interface Vault {
  createStaging(dumpId: DumpId): void;
  append(dumpId: DumpId, bytes: Uint8Array): void;
  syncAndClose(dumpId: DumpId): void;
  promote(dumpId: DumpId): void;
  openImmutable(dumpId: DumpId): VaultReader;
  removeStaging(dumpId: DumpId): void;
  remove(dumpId: DumpId): void;
  inspectPresence(dumpId: DumpId): VaultPresence;
  listStagingIds(): readonly DumpId[];
  stagingModifiedAt(dumpId: DumpId): number | null;
}
