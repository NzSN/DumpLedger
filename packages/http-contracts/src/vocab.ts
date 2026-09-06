/**
 * Shared wire vocabulary for the DumpLedger browser/Fastify interface.
 *
 * These string vocabularies mirror the authoritative domain language in
 * `CONTEXT.md`, `specs/DumpLedger.tla`, and `src/domain/lifecycle.ts`. The
 * contract package deliberately re-declares them as plain wire literals so it
 * stays framework-free and independent of the lifecycle engine: the backend
 * route layer and the generated engine port are the authorities that must
 * emit exactly these values.
 *
 * `CaseAction` uses the exact TLA+/generated-port action names. It is the
 * single wire representation for case transitions; the lifecycle engine
 * re-checks every transition at execution time.
 */

import {
  arrayOf,
  canonicalTimestamp,
  field,
  object,
  oneOf,
  optional,
  text,
  type Decoder,
} from "./decode.js";

export const CASE_STATUSES = ["new", "investigating", "waiting-for-customer", "resolved", "closed"] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export const CASE_ACTIONS = [
  "StartInvestigation",
  "WaitForCustomer",
  "ResumeInvestigation",
  "ResolveCase",
  "CloseCase",
] as const;
export type CaseAction = (typeof CASE_ACTIONS)[number];

export const GRANT_STATES = ["issued", "consumed", "revoked", "expired"] as const;
export type GrantState = (typeof GRANT_STATES)[number];

export const DUMP_PHASES = [
  "receiving",
  "sealed",
  "quarantined",
  "available",
  "rejected",
  "deleting",
  "deleted",
] as const;
export type DumpPhase = (typeof DUMP_PHASES)[number];

export const VALIDATION_STATES = ["not-checked", "valid", "invalid", "transfer-failed"] as const;
export type ValidationState = (typeof VALIDATION_STATES)[number];

export const COVERAGE_KINDS = ["partial", "full-memory-declared", "unknown"] as const;
export type CoverageKind = (typeof COVERAGE_KINDS)[number];

export const caseStatusDecoder: Decoder<CaseStatus> = oneOf(CASE_STATUSES, "case status");
export const caseActionDecoder: Decoder<CaseAction> = oneOf(CASE_ACTIONS, "case action");
export const grantStateDecoder: Decoder<GrantState> = oneOf(GRANT_STATES, "grant state");
export const dumpPhaseDecoder: Decoder<DumpPhase> = oneOf(DUMP_PHASES, "dump phase");
export const validationStateDecoder: Decoder<ValidationState> = oneOf(VALIDATION_STATES, "validation state");
export const coverageKindDecoder: Decoder<CoverageKind> = oneOf(COVERAGE_KINDS, "coverage kind");

/** One bounded, safely-echoable lifecycle event shown on case and dump pages. */
export interface ActivityItem {
  readonly occurredAt: string;
  readonly action: string;
  readonly outcome?: string;
}

export const decodeActivityItem: Decoder<ActivityItem> = (value, path) => {
  const decoded = object(
    {
      occurredAt: field(canonicalTimestamp("activity occurredAt")),
      action: field(text({ max: 64, label: "activity action" })),
      outcome: optional(text({ max: 256, label: "activity outcome" })),
    },
    "activity item",
  )(value, path);
  return {
    occurredAt: decoded.occurredAt,
    action: decoded.action,
    ...(decoded.outcome === undefined ? {} : { outcome: decoded.outcome }),
  };
};

export function encodeActivityItem(item: ActivityItem): Record<string, unknown> {
  const output: Record<string, unknown> = {
    occurredAt: item.occurredAt,
    action: item.action,
  };
  if (item.outcome !== undefined) output.outcome = item.outcome;
  return output;
}

export function decodeActivityItems(value: unknown, path: string): readonly ActivityItem[] {
  return arrayOf(decodeActivityItem, { label: "activity", maxLength: 200 })(value, path);
}

