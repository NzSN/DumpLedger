/**
 * Checked application suite declarations (Mirrors
 * application-integration-guide + MirrorECMA application-suites): the
 * reviewed models, generated suite handles, checked trace corpora, and the
 * acceptance requirements each replay must evidence. defineSuite performs
 * no I/O; trace hashes are computed by the caller (test setup) and pinned.
 */

import { defineSuite } from "mirrorecma";

import { DumpLedgerModel } from "../generated/dump-ledger-suite/DumpLedger.suite.js";
import { DumpLedgerTransferModel } from "../generated/dump-ledger-transfer-suite/DumpLedgerTransfer.suite.js";

export interface PinnedTrace {
  readonly path: string;
  readonly sha256: string;
}

/** Transition wire actions the base corpus must evidence (per preflight). */
export const BASE_REQUIRED_ACTIONS = [
  "AcceptDump", "BeginPurge", "BeginUpload", "CloseCase", "ExpireToken",
  "FailUpload", "FinishPurge", "IngestSymbol", "IssueToken",
  "MarkQuarantined", "PromoteObject", "PurgeSymbol", "RejectDump",
  "ResolveCase", "ResumeInvestigation", "RevokeToken", "SealUpload",
  "StartInvestigation", "WaitForCustomer",
] as const;

/** Transition wire actions the transfer corpus must evidence. */
export const TRANSFER_REQUIRED_ACTIONS = [
  "AcceptDump", "BeginPurge", "BeginUpload", "DeleteBundle", "ExportFail",
  "ExportSeal", "ExportStart", "FinishPurge", "ImportCase", "ImportCustomer",
  "ImportDumpOk", "ImportDumpReject", "ImportDumpTombD", "ImportDumpTombR",
  "ImportFinish", "ImportHardFail", "ImportStart", "ImportTokens",
  "IssueToken", "MarkQuarantined", "PromoteObject", "RejectDump",
  "SealUpload", "TamperBundle", "WipeInstance",
] as const;

export function defineDumpLedgerSuite(specPath: string, traces: readonly PinnedTrace[]) {
  return defineSuite({
    id: "dump-ledger/v1",
    model: DumpLedgerModel,
    replay: {
      kind: "corpus",
      config: {
        specPath,
        initPredicate: "Init",
        nextPredicate: "Next",
        invariant: "SafetyInvariant",
        lengthBound: 6,
        paramVars: "parameters",
      },
      traces: [...traces],
    },
    acceptance: { requiredActions: [...BASE_REQUIRED_ACTIONS], requiredPairs: [] },
  });
}

export function defineTransferSuite(specPath: string, traces: readonly PinnedTrace[]) {
  return defineSuite({
    id: "dump-ledger-transfer/v1",
    model: DumpLedgerTransferModel,
    replay: {
      kind: "corpus",
      config: {
        specPath,
        initPredicate: "TransferInit",
        nextPredicate: "TransferNext",
        invariant: "TransferSafetyFull",
        lengthBound: 28,
        paramVars: "parameters",
      },
      traces: [...traces],
    },
    acceptance: { requiredActions: [...TRANSFER_REQUIRED_ACTIONS], requiredPairs: [] },
  });
}
