/**
 * Shared presentation vocabulary for the wire statuses defined by
 * @dump-ledger/http-contracts. Only contract vocabularies are mapped here so
 * presentation cannot drift from the runtime-validated wire values.
 */

import type {
  CaseAction,
  CaseStatus,
  CoverageKind,
  DumpPhase,
  GrantState,
  IntegrityStatus,
  UploadCompletePhase,
  ValidationState,
} from "@dump-ledger/http-contracts";

export type StatusTone = "good" | "info" | "warn" | "bad" | "muted";

export interface StatusPresentation {
  readonly tone: StatusTone;
  readonly label: string;
}

export function caseStatusPresentation(status: CaseStatus): StatusPresentation {
  switch (status) {
    case "new":
      return { tone: "info", label: "New" };
    case "investigating":
      return { tone: "info", label: "Investigating" };
    case "waiting-for-customer":
      return { tone: "warn", label: "Waiting for customer" };
    case "resolved":
      return { tone: "good", label: "Resolved" };
    case "closed":
      return { tone: "muted", label: "Closed" };
  }
}

export function grantStatePresentation(state: GrantState): StatusPresentation {
  switch (state) {
    case "issued":
      return { tone: "info", label: "Issued" };
    case "consumed":
      return { tone: "good", label: "Consumed" };
    case "revoked":
      return { tone: "warn", label: "Revoked" };
    case "expired":
      return { tone: "muted", label: "Expired" };
  }
}

export function dumpPhasePresentation(phase: DumpPhase | UploadCompletePhase): StatusPresentation {
  switch (phase) {
    case "receiving":
      return { tone: "info", label: "Receiving" };
    case "sealed":
      return { tone: "info", label: "Sealed" };
    case "quarantined":
      return { tone: "warn", label: "Quarantined" };
    case "available":
      return { tone: "good", label: "Available" };
    case "rejected":
      return { tone: "bad", label: "Rejected" };
    case "deleting":
      return { tone: "warn", label: "Deleting" };
    case "deleted":
      return { tone: "muted", label: "Deleted" };
  }
}

export function validationStatePresentation(state: ValidationState): StatusPresentation {
  switch (state) {
    case "not-checked":
      return { tone: "muted", label: "Not checked" };
    case "valid":
      return { tone: "good", label: "Valid" };
    case "invalid":
      return { tone: "bad", label: "Invalid" };
    case "transfer-failed":
      return { tone: "bad", label: "Transfer failed" };
  }
}

export function coverageKindLabel(kind: CoverageKind | null): string {
  switch (kind) {
    case "partial":
      return "Partial";
    case "full-memory-declared":
      return "Full memory declared";
    case "unknown":
      return "Unknown";
    case null:
      return "Unclassified";
  }
}

export function integrityStatusPresentation(status: IntegrityStatus): StatusPresentation {
  switch (status) {
    case "ok":
      return { tone: "good", label: "OK" };
    case "degraded":
      return { tone: "warn", label: "Degraded" };
  }
}

/** Readable labels for the five generated case-transition action names. */
export function caseActionLabel(action: CaseAction): string {
  switch (action) {
    case "StartInvestigation":
      return "Start investigation";
    case "WaitForCustomer":
      return "Wait for customer";
    case "ResumeInvestigation":
      return "Resume investigation";
    case "ResolveCase":
      return "Resolve case";
    case "CloseCase":
      return "Close case";
  }
}
