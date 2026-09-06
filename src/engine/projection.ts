import type { StableError } from "../domain/errors.js";
import type { AuditEventId, CaseId, CustomerId, DumpId, GrantId } from "../domain/ids.js";
import type { BlobState, CaseStatus, CoverageKind, DumpPhase, TokenState, ValidationState } from "../domain/lifecycle.js";
import type { LifecycleAction } from "./commands.js";

export interface CustomerProjection { readonly customerId: CustomerId; readonly displayName: string; readonly createdAt: string }
export interface CaseProjection { readonly caseId: CaseId; readonly customerId: CustomerId; readonly title: string; readonly status: CaseStatus; readonly createdAt: string }
export interface GrantProjection { readonly grantId: GrantId; readonly caseId: CaseId; readonly state: TokenState; readonly expiresAt: string; readonly maxBytes: bigint; readonly consumedByDumpId: DumpId | null; readonly createdAt: string }
export interface DumpProjection {
  readonly dumpId: DumpId; readonly caseId: CaseId; readonly phase: DumpPhase; readonly blobState: BlobState;
  readonly originalName: string; readonly byteSize: bigint | null; readonly sha256: string | null;
  readonly validation: ValidationState; readonly coverage: CoverageKind | null; readonly downloadable: boolean;
  readonly inspectionError: string | null; readonly receivedAt: string; readonly availableAt: string | null;
  readonly purgeAt: string | null; readonly purgedAt: string | null;
}
export interface AuditEventProjection { readonly eventId: AuditEventId; readonly occurredAt: string; readonly action: string; readonly customerId: CustomerId | null; readonly caseId: CaseId | null; readonly dumpId: DumpId | null; readonly detail: Readonly<Record<string, unknown>> }
export interface DumpLedgerProjection { readonly customers: readonly CustomerProjection[]; readonly cases: readonly CaseProjection[]; readonly grants: readonly GrantProjection[]; readonly dumps: readonly DumpProjection[]; readonly downloadable: readonly DumpId[]; readonly auditEvents: readonly AuditEventProjection[] }
export interface BackupInventoryDump { readonly dumpId: DumpId; readonly caseId: CaseId; readonly phase: DumpPhase; readonly byteSize: string | null; readonly sha256: string | null; readonly purgeAt: string | null; readonly purgedAt: string | null }
export interface BackupInventory { readonly schema: "dump-ledger.backup-inventory/v1"; readonly generatedAt: string; readonly includesVaultBytes: false; readonly dumps: readonly BackupInventoryDump[] }
export interface TransitionSuccess { readonly ok: true; readonly action: LifecycleAction; readonly occurredAt: string; readonly customerId?: CustomerId; readonly caseId?: CaseId; readonly grantId?: GrantId; readonly grantSecret?: string; readonly dumpId?: DumpId; readonly maxBytes?: bigint; readonly phase?: DumpPhase; readonly dump?: DumpProjection; readonly purgeAt?: string; readonly revokedGrantIds?: readonly GrantId[] }
export interface TransitionFailure { readonly ok: false; readonly action: LifecycleAction; readonly error: StableError }
export type TransitionReceipt = TransitionSuccess | TransitionFailure;
