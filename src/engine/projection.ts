import type { StableError } from "../domain/errors.js";
import type { AuditEventId, CaseId, CustomerId, DumpId, GrantId, SymbolArtifactId } from "../domain/ids.js";
import type { BlobState, CaseStatus, CoverageKind, DumpPhase, SymbolArtifactKind, TokenState, ValidationState } from "../domain/lifecycle.js";
import type { LifecycleAction } from "./commands.js";

export interface CustomerProjection { readonly customerId: CustomerId; readonly displayName: string; readonly createdAt: string }
export interface CaseProjection { readonly caseId: CaseId; readonly customerId: CustomerId; readonly title: string; readonly status: CaseStatus; readonly createdAt: string }
export interface GrantProjection { readonly grantId: GrantId; readonly caseId: CaseId; readonly state: TokenState; readonly expiresAt: string; readonly maxBytes: bigint; readonly maxUploads: number; readonly uploadsUsed: number; readonly consumedByDumpId: DumpId | null; readonly createdAt: string }
export interface DumpProjection {
  readonly dumpId: DumpId; readonly caseId: CaseId; readonly phase: DumpPhase; readonly blobState: BlobState;
  readonly originalName: string; readonly byteSize: bigint | null; readonly sha256: string | null;
  readonly validation: ValidationState; readonly coverage: CoverageKind | null; readonly downloadable: boolean;
  readonly inspectionError: string | null; readonly inspectionFacts: Readonly<Record<string, unknown>> | null;
  readonly receivedAt: string; readonly availableAt: string | null;
  readonly purgeAt: string | null; readonly purgedAt: string | null;
}
/** Any stored symbol artifact (docs/symbols-design.md, milestone 3): a `pdb`
 * artifact resolves by its debug identity, an `exe` (EXE/DLL image) by its
 * code identity, and the pair that does not apply is null. */
export interface StoredSymbolArtifact {
  readonly artifactId: SymbolArtifactId;
  readonly kind: SymbolArtifactKind;
  /** Debug identity (RSDS); non-null exactly for `pdb` artifacts. */
  readonly debugFile: string | null;
  readonly debugId: string | null;
  /** Code identity (PE TimeDateStamp + SizeOfImage); non-null exactly for `exe` artifacts. */
  readonly codeFile: string | null;
  readonly codeId: string | null;
  readonly byteSize: bigint;
  readonly sha256: string;
  readonly product: string | null;
  readonly version: string | null;
  readonly arch: string | null;
  readonly createdAt: string;
}
/**
 * The debug-identity view of the symbol store: the artifacts that resolve by a
 * debug identity (kind `pdb`). `snapshot()` hands this view to the transfer
 * export, whose bundle manifest is PDB-only (`src/transfer/manifest.ts`), and
 * to dump/case symbol coverage, which joins on debug identities; EXE artifacts
 * are listed through `listSymbolArtifacts()` (GET /api/v1/symbols). The name is
 * the transfer-facing one: `selectSymbols` declares its parameter as
 * `readonly SymbolArtifactProjection[]` and reads the debug pair directly, so
 * this view keeps both fields non-null.
 */
export type SymbolArtifactProjection = StoredSymbolArtifact & {
  readonly kind: "pdb";
  readonly debugFile: string;
  readonly debugId: string;
};
export interface AuditEventProjection { readonly eventId: AuditEventId; readonly occurredAt: string; readonly action: string; readonly customerId: CustomerId | null; readonly caseId: CaseId | null; readonly dumpId: DumpId | null; readonly detail: Readonly<Record<string, unknown>> }
export interface DumpLedgerProjection { readonly customers: readonly CustomerProjection[]; readonly cases: readonly CaseProjection[]; readonly grants: readonly GrantProjection[]; readonly dumps: readonly DumpProjection[]; readonly downloadable: readonly DumpId[]; readonly symbols: readonly SymbolArtifactProjection[]; readonly auditEvents: readonly AuditEventProjection[] }
export interface BackupInventoryDump { readonly dumpId: DumpId; readonly caseId: CaseId; readonly phase: DumpPhase; readonly byteSize: string | null; readonly sha256: string | null; readonly purgeAt: string | null; readonly purgedAt: string | null }
export interface BackupInventory { readonly schema: "dump-ledger.backup-inventory/v1"; readonly generatedAt: string; readonly includesVaultBytes: false; readonly dumps: readonly BackupInventoryDump[] }
export interface TransitionSuccess { readonly ok: true; readonly action: LifecycleAction; readonly occurredAt: string; readonly importId?: AuditEventId; readonly customerId?: CustomerId; readonly caseId?: CaseId; readonly grantId?: GrantId; readonly grantSecret?: string; readonly dumpId?: DumpId; readonly maxBytes?: bigint; readonly maxUploads?: number; readonly phase?: DumpPhase; readonly artifactId?: SymbolArtifactId; readonly deduplicated?: boolean; readonly dump?: DumpProjection; readonly purgeAt?: string; readonly revokedGrantIds?: readonly GrantId[] }
export interface TransitionFailure { readonly ok: false; readonly action: LifecycleAction; readonly error: StableError }
export type TransitionReceipt = TransitionSuccess | TransitionFailure;

/** Narrows a stored artifact to the debug-identity view (`snapshot()` symbols). */
export function isDebugSymbolArtifact(artifact: StoredSymbolArtifact): artifact is SymbolArtifactProjection {
  return artifact.kind === "pdb" && artifact.debugFile !== null && artifact.debugId !== null;
}
