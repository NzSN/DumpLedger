export const ErrorCodes = ["invalid_input", "not_found", "invalid_transition", "grant_invalid", "grant_expired", "grant_consumed", "storage_unavailable", "integrity_failure", "inspection_outcome_mismatch"] as const;
export type ErrorCode = (typeof ErrorCodes)[number];
export interface StableError { readonly code: ErrorCode; readonly message: string }

export class DumpLedgerError extends Error {
  constructor(readonly code: ErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DumpLedgerError";
  }
}

export class SimulatedCrash extends Error {
  constructor(readonly checkpoint: string) {
    super(`simulated crash at ${checkpoint}`);
    this.name = "SimulatedCrash";
  }
}
