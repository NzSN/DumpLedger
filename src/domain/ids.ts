const IdentifierBody = /^[0-9A-HJKMNP-TV-Z]{26}$/;
type Brand<T, Name extends string> = T & { readonly __brand: Name };

export type CustomerId = Brand<string, "CustomerId">;
export type CaseId = Brand<string, "CaseId">;
export type GrantId = Brand<string, "GrantId">;
export type DumpId = Brand<string, "DumpId">;
export type AuditEventId = Brand<string, "AuditEventId">;
export type IdentifierKind = "customer" | "case" | "grant" | "dump" | "audit";

function parseIdentifier<Id extends string>(value: unknown, prefix: string, label: string): Id {
  if (typeof value !== "string") throw new TypeError(`invalid ${label} identifier`);
  const body = value.slice(prefix.length + 1);
  if (!value.startsWith(`${prefix}_`) || !IdentifierBody.test(body)) {
    throw new TypeError(`invalid ${label} identifier`);
  }
  return value as Id;
}

export const parseCustomerId = (value: unknown): CustomerId => parseIdentifier(value, "customer", "customer");
export const parseCaseId = (value: unknown): CaseId => parseIdentifier(value, "case", "case");
export const parseGrantId = (value: unknown): GrantId => parseIdentifier(value, "grant", "grant");
export const parseDumpId = (value: unknown): DumpId => parseIdentifier(value, "dump", "dump");
export const parseAuditEventId = (value: unknown): AuditEventId => parseIdentifier(value, "audit", "audit event");

export interface IdSource {
  next(kind: "customer"): CustomerId;
  next(kind: "case"): CaseId;
  next(kind: "grant"): GrantId;
  next(kind: "dump"): DumpId;
  next(kind: "audit"): AuditEventId;
}

export function parseGeneratedId(kind: IdentifierKind, value: unknown): string {
  switch (kind) {
    case "customer": return parseCustomerId(value);
    case "case": return parseCaseId(value);
    case "grant": return parseGrantId(value);
    case "dump": return parseDumpId(value);
    case "audit": return parseAuditEventId(value);
  }
}
