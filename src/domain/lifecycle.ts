export const TokenStates = ["issued", "consumed", "revoked", "expired"] as const;
export type TokenState = (typeof TokenStates)[number];
export const DumpPhases = ["receiving", "sealed", "quarantined", "available", "rejected", "deleting", "deleted"] as const;
export type DumpPhase = (typeof DumpPhases)[number];
export const BlobStates = ["staging", "vault", "none"] as const;
export type BlobState = (typeof BlobStates)[number];
export const ValidationStates = ["not-checked", "valid", "invalid", "transfer-failed"] as const;
export type ValidationState = (typeof ValidationStates)[number];
export const CoverageKinds = ["partial", "full-memory-declared", "unknown"] as const;
export type CoverageKind = (typeof CoverageKinds)[number];
export const CaseStatuses = ["new", "investigating", "waiting-for-customer", "resolved", "closed"] as const;
export type CaseStatus = (typeof CaseStatuses)[number];

export function isCoverageKind(value: unknown): value is CoverageKind {
  return typeof value === "string" && CoverageKinds.includes(value as CoverageKind);
}

function parseMember<T extends string>(values: readonly T[], value: unknown, label: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) throw new TypeError(`invalid ${label}`);
  return value as T;
}

export const parseTokenState = (value: unknown): TokenState => parseMember(TokenStates, value, "token state");
export const parseDumpPhase = (value: unknown): DumpPhase => parseMember(DumpPhases, value, "dump phase");
export const parseBlobState = (value: unknown): BlobState => parseMember(BlobStates, value, "blob state");
export const parseValidationState = (value: unknown): ValidationState => parseMember(ValidationStates, value, "validation state");
export const parseCaseStatus = (value: unknown): CaseStatus => parseMember(CaseStatuses, value, "case status");
