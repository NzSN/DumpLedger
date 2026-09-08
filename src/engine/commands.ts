import type { AuditEventId, CaseId, CustomerId, DumpId, GrantId } from "../domain/ids.js";
import type { CaseStatus, CoverageKind, TokenState, ValidationState } from "../domain/lifecycle.js";

/** Entity counts advertised by an export manifest and reported back at import completion. */
export interface ImportCounts {
  readonly customers: number;
  readonly cases: number;
  readonly grants: number;
  readonly dumps: number;
  readonly auditEvents?: number;
}
/** Completion summary recorded by FinishImport; the manifest digest is echoed from the BeginImport marker. */
export interface ImportSummary {
  readonly imported: ImportCounts;
  readonly skipped: number;
}
/** A customer row as exported: original branded ID and original creation timestamp. */
export interface ImportCustomerRecord {
  readonly customerId: CustomerId;
  readonly displayName: string;
  readonly createdAt: string;
}
/** A case row as exported: case workflow status is preserved as recorded. */
export interface ImportCaseRecord {
  readonly caseId: CaseId;
  readonly customerId: CustomerId;
  readonly title: string;
  readonly status: CaseStatus;
  readonly createdAt: string;
}
/** A grant row as exported, including the secret digest so grants stay verifiable under the same key. */
export interface ImportGrantRecord {
  readonly grantId: GrantId;
  readonly caseId: CaseId;
  readonly secretDigest: string;
  readonly state: TokenState;
  readonly expiresAt: string;
  readonly maxBytes: bigint;
  readonly consumedByDumpId: DumpId | null;
  readonly createdAt: string;
}
/**
 * A dump row as exported. Phase "available" records are re-entered at sealed/staging and must pass
 * quarantine and inspection again; "rejected"/"deleted" records import as metadata-only tombstones.
 */
export interface ImportDumpRecord {
  readonly dumpId: DumpId;
  readonly caseId: CaseId;
  readonly phase: "available" | "rejected" | "deleted";
  readonly originalName: string;
  readonly byteSize: bigint | null;
  readonly sha256: string | null;
  readonly validation: ValidationState;
  readonly coverage: CoverageKind | null;
  readonly inspectionError: string | null;
  readonly inspectionFacts?: Readonly<Record<string, unknown>>;
  readonly receivedAt: string;
  readonly availableAt: string | null;
  readonly purgeAt: string | null;
  readonly purgedAt: string | null;
}

/**
 * An audit event row as exported. Imported verbatim (original event ID and
 * timestamp) so the historical audit trail survives instance migration; the
 * command writes no additional audit event of its own.
 */
export interface ImportAuditEventRecord {
  readonly eventId: AuditEventId;
  readonly occurredAt: string;
  readonly action: string;
  readonly customerId: CustomerId | null;
  readonly caseId: CaseId | null;
  readonly dumpId: DumpId | null;
  readonly detail: Readonly<Record<string, unknown>>;
}

export type LifecycleCommand =
  | { readonly type: "CreateCustomer"; readonly displayName: string }
  | { readonly type: "CreateCase"; readonly customerId: CustomerId; readonly title: string }
  | { readonly type: "StartInvestigation"; readonly caseId: CaseId }
  | { readonly type: "WaitForCustomer"; readonly caseId: CaseId }
  | { readonly type: "ResumeInvestigation"; readonly caseId: CaseId }
  | { readonly type: "ResolveCase"; readonly caseId: CaseId }
  | { readonly type: "CloseCase"; readonly caseId: CaseId }
  | { readonly type: "IssueGrant"; readonly caseId: CaseId; readonly expiresAt: string; readonly maxBytes: bigint }
  | { readonly type: "RevokeGrant"; readonly grantId: GrantId }
  | { readonly type: "ExpireGrant"; readonly grantId: GrantId }
  | { readonly type: "BeginUpload"; readonly grantSecret: string; readonly originalName: string }
  | { readonly type: "SealUpload"; readonly dumpId: DumpId; readonly byteSize: bigint; readonly sha256: string }
  | { readonly type: "FailUpload"; readonly dumpId: DumpId }
  | { readonly type: "PromoteObject"; readonly dumpId: DumpId }
  | { readonly type: "MarkQuarantined"; readonly dumpId: DumpId }
  | { readonly type: "AcceptDump"; readonly dumpId: DumpId }
  | { readonly type: "RejectDump"; readonly dumpId: DumpId }
  | { readonly type: "AuthorizeDownload"; readonly dumpId: DumpId }
  | { readonly type: "SetRetention"; readonly dumpId: DumpId; readonly purgeAt: string }
  | { readonly type: "BeginPurge"; readonly dumpId: DumpId }
  | { readonly type: "FinishPurge"; readonly dumpId: DumpId }
  | { readonly type: "BeginImport"; readonly manifestDigest: string; readonly counts: ImportCounts }
  | { readonly type: "ImportCustomer"; readonly record: ImportCustomerRecord }
  | { readonly type: "ImportCase"; readonly record: ImportCaseRecord }
  | { readonly type: "ImportGrant"; readonly record: ImportGrantRecord; readonly forcedState?: "revoked" }
  | { readonly type: "ImportDumpStaged"; readonly record: ImportDumpRecord }
  | { readonly type: "ImportAuditEvent"; readonly record: ImportAuditEventRecord }
  | { readonly type: "FinishImport"; readonly importId: AuditEventId; readonly summary: ImportSummary };
export type LifecycleAction = LifecycleCommand["type"];
