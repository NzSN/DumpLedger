import type { DumpId, SymbolArtifactId } from "../domain/ids.js";
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

/**
 * Symbol-artifact storage (docs/symbols-design.md): a namespace parallel to
 * dump objects — `<root>/symbols-staging/<artifactId>.part` and
 * `<root>/symbols/<artifactId>/artifact.bin`, deliberately OUTSIDE the dump
 * staging root so recovery reconcile's `*.part` scan never sees symbol
 * staging. Both shipped vaults implement this alongside Vault.
 */
export interface SymbolVault {
  createSymbolStaging(artifactId: SymbolArtifactId): void;
  appendSymbol(artifactId: SymbolArtifactId, bytes: Uint8Array): void;
  syncAndCloseSymbol(artifactId: SymbolArtifactId): void;
  /** Read-only access to a synced (sealed) staging object, for post-ingest
   * identity verification against the full staged bytes; `undefined` when no
   * staging object exists, invalid_transition while still write-open. */
  openSymbolStagingReader(artifactId: SymbolArtifactId): VaultReader | undefined;
  promoteSymbol(artifactId: SymbolArtifactId): void;
  openSymbol(artifactId: SymbolArtifactId): VaultReader | undefined;
  removeSymbolStaging(artifactId: SymbolArtifactId): void;
  removeSymbol(artifactId: SymbolArtifactId): void;
  symbolPresence(artifactId: SymbolArtifactId): VaultPresence;
}
