/**
 * Typed fixture factories for T5 operator feature tests.
 *
 * Responders on `OperatorFakeHttpClient` return already-decoded values (the
 * shared client owns runtime decoding), so these factories produce exact
 * contract-typed objects. They stay pure data — no RTL/user-event imports —
 * so feature test files can share one vocabulary of realistic ledger state.
 */

import type {
  ActivityItem,
  CaseAction,
  CaseDetailResponse,
  CaseGrantSummary,
  CaseStatus,
  CaseDumpSummary,
  CaseSummary,
  DumpDetailResponse,
  ExportStatus,
  ExportSummary,
  GrantState,
  ImportProgressResponse,
  ImportStatus,
  IssuedGrant,
  OperationsResponse,
  RuntimeJobSummary,
  TransitionResponse,
} from "@dump-ledger/http-contracts";

export function activityItem(occurredAt: string, action: string, outcome?: string): ActivityItem {
  return outcome === undefined ? { occurredAt, action } : { occurredAt, action, outcome };
}

export function caseSummary(
  caseId: string,
  title: string,
  status: CaseStatus = "new",
  createdAt = "2026-09-01T10:00:00.000Z",
): CaseSummary {
  return { caseId, customerId: "customer-acme", title, status, createdAt };
}

export function caseGrant(
  grantId: string,
  state: GrantState,
  expiresAt = "2026-09-08T10:00:00.000Z",
  maxBytes = 10737418240n,
): CaseGrantSummary {
  return { grantId, state, createdAt: "2026-09-01T09:00:00.000Z", expiresAt, maxBytes };
}

export function caseDump(
  dumpId: string,
  phase: CaseDumpSummary["phase"],
  originalName = "minidump.dmp",
  byteSize: bigint | null = 10485760n,
): CaseDumpSummary {
  return { dumpId, phase, originalName, byteSize, receivedAt: "2026-09-01T11:00:00.000Z" };
}

export interface CaseDetailOverrides {
  readonly status?: CaseStatus;
  readonly allowedActions?: readonly CaseAction[];
  readonly grants?: readonly CaseGrantSummary[];
  readonly dumps?: readonly CaseDumpSummary[];
  readonly activity?: readonly ActivityItem[];
  readonly title?: string;
  readonly customerId?: string;
  readonly caseId?: string;
}

export function caseDetailFixture(overrides: CaseDetailOverrides = {}): CaseDetailResponse {
  return {
    caseId: overrides.caseId ?? "case-1001",
    customerId: overrides.customerId ?? "customer-acme",
    title: overrides.title ?? "Renderer crash on startup",
    status: overrides.status ?? "new",
    createdAt: "2026-09-01T10:00:00.000Z",
    customer: { customerId: overrides.customerId ?? "customer-acme", displayName: "Acme Corp" },
    allowedActions: overrides.allowedActions ?? ["StartInvestigation", "CloseCase"],
    grants: overrides.grants ?? [],
    dumps: overrides.dumps ?? [],
    activity:
      overrides.activity ??
      [activityItem("2026-09-01T10:00:00.000Z", "CaseOpened"), activityItem("2026-09-01T10:05:00.000Z", "CaseStarted")],
  };
}

export function transitionFixture(
  action: CaseAction,
  status: CaseStatus,
  revokedGrants?: { readonly count: number; readonly grantIds: readonly string[] },
): TransitionResponse {
  return {
    caseId: "case-1001",
    action,
    status,
    occurredAt: "2026-09-02T08:00:00.000Z",
    ...(revokedGrants === undefined ? {} : { revokedGrants }),
  };
}

export function issuedGrantRecord(
  grantId: string,
  caseId = "case-1001",
  expiresAt = "2026-09-08T10:00:00.000Z",
  maxBytes = 10737418240n,
): IssuedGrant {
  return {
    grantId,
    caseId,
    state: "issued",
    createdAt: "2026-09-01T09:00:00.000Z",
    expiresAt,
    maxBytes,
  };
}

export interface DumpDetailOverrides {
  readonly phase?: DumpDetailResponse["phase"];
  readonly downloadable?: boolean;
  readonly purgeAt?: string | null;
  readonly byteSize?: bigint | null;
  readonly sha256?: string | null;
  readonly validation?: DumpDetailResponse["validation"];
  readonly coverage?: DumpDetailResponse["coverage"];
  readonly inspectionError?: string | null;
  readonly activity?: readonly ActivityItem[];
  readonly availableAt?: string | null;
  readonly purgedAt?: string | null;
  readonly dumpId?: string;
}

export function dumpDetailFixture(overrides: DumpDetailOverrides = {}): DumpDetailResponse {
  return {
    dumpId: overrides.dumpId ?? "dump-9001",
    case: { caseId: "case-1001", title: "Renderer crash on startup" },
    phase: overrides.phase ?? "available",
    originalName: "minidump.dmp",
    byteSize: overrides.byteSize ?? 10485760n,
    sha256: overrides.sha256 ?? null,
    validation: overrides.validation ?? "valid",
    coverage: overrides.coverage ?? "full-memory-declared",
    downloadable: overrides.downloadable ?? true,
    receivedAt: "2026-09-01T11:00:00.000Z",
    availableAt: overrides.availableAt ?? "2026-09-01T11:02:00.000Z",
    purgeAt: overrides.purgeAt ?? null,
    purgedAt: overrides.purgedAt ?? null,
    inspectionError: overrides.inspectionError ?? null,
    activity:
      overrides.activity ??
      [
        activityItem("2026-09-01T11:00:00.000Z", "DumpReceived"),
        activityItem("2026-09-01T11:02:00.000Z", "DumpValidated", "valid"),
      ],
  };
}

export function runtimeJob(
  name: string,
  running = false,
  runs = 1,
  failures = 0,
): RuntimeJobSummary {
  return { name, running, runs, failures };
}

export interface OperationsOverrides {
  readonly integrityStatus?: "ok" | "degraded";
  readonly integrityErrors?: readonly string[];
  readonly jobs?: readonly RuntimeJobSummary[];
}

export function operationsFixture(overrides: OperationsOverrides = {}): OperationsResponse {
  const degraded = overrides.integrityStatus === "degraded";
  return {
    integrity: {
      status: overrides.integrityStatus ?? "ok",
      errorCount: degraded ? (overrides.integrityErrors ?? []).length : 0,
      errors: degraded ? (overrides.integrityErrors ?? []) : [],
    },
    uploads: { active: 2, capacity: 8 },
    postProcessing: { pending: 1, exhausted: 0, totalRetries: 3 },
    runtimeJobs: overrides.jobs ?? [runtimeJob("retention-sweep", true, 12, 0)],
  };
}

export interface ExportSummaryOverrides {
  readonly status?: ExportStatus;
  readonly byteSize?: string | null;
  readonly error?: string | null;
  readonly createdAt?: string;
}

export function exportSummary(
  exportId: string,
  overrides: ExportSummaryOverrides = {},
): ExportSummary {
  const status = overrides.status ?? "sealed";
  return {
    exportId,
    status,
    createdAt: overrides.createdAt ?? "2026-09-05T12:00:00.000Z",
    byteSize:
      overrides.byteSize === undefined ? (status === "sealed" ? "10485760" : null) : overrides.byteSize,
    error: overrides.error === undefined ? (status === "failed" ? "Vault read failed." : null) : overrides.error,
  };
}

export function importProgress(
  importId: string,
  status: ImportStatus,
  overrides: { readonly verified?: number; readonly imported?: number; readonly rejected?: number; readonly skipped?: number; readonly error?: string | null } = {},
): ImportProgressResponse {
  return {
    importId,
    status,
    verified: overrides.verified ?? 0,
    imported: overrides.imported ?? 0,
    rejected: overrides.rejected ?? 0,
    skipped: overrides.skipped ?? 0,
    error:
      overrides.error === undefined ? (status === "failed" ? "Bundle verification failed." : null) : overrides.error,
  };
}
