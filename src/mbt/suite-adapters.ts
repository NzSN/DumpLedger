/**
 * Suite adapters (Mirrors application-integration-guide): native adapter
 * factories binding the existing DumpLedger MBT harnesses to the generated
 * suite models (mirrors.suite-model/v1 over mirrors.node-native/v1). The
 * harnesses stay authoritative for engine/vault setup and reset; these
 * adapters only rename the wire surface into the suite's capitalized native
 * representation. One adapter instance serves the whole corpus: the
 * harnesses' initialize() resets the SUT for each trace.
 */

import type { DumpLedgerNativeAdapter, DumpLedgerNativeObservation } from "../generated/dump-ledger-suite/DumpLedger.suite.js";
import type { DumpLedgerTransferNativeAdapter, DumpLedgerTransferNativeObservation } from "../generated/dump-ledger-transfer-suite/DumpLedgerTransfer.suite.js";
import { createMbtProbe, MbtHarness, type MbtHarnessOptions, type MbtProbe } from "./harness.js";
import { createTransferProbe, TransferMbtHarness, type TransferProbe } from "./transfer-harness.js";

export interface DumpLedgerSuiteAdapter extends DumpLedgerNativeAdapter {
  readonly probe: MbtProbe;
  readonly harness: MbtHarness;
}

export function createDumpLedgerSuiteAdapter(
  options: { readonly probe?: MbtProbe; readonly harness?: MbtHarnessOptions } = {},
): DumpLedgerSuiteAdapter {
  const probe = options.probe ?? createMbtProbe();
  const harness = new MbtHarness(probe, options.harness);
  return {
    probe,
    harness,
    actions: {
      AcceptDump: (inputs) => harness.acceptDump(inputs["Dump"], inputs["Kind"]),
      BeginPurge: (inputs) => harness.beginPurge(inputs["Dump"]),
      BeginUpload: (inputs) => harness.beginUpload(inputs["Token"], inputs["Dump"]),
      CloseCase: (inputs) => harness.closeCase(inputs["Case"]),
      ExpireToken: (inputs) => harness.expireToken(inputs["Token"]),
      FailUpload: (inputs) => harness.failUpload(inputs["Dump"]),
      FinishPurge: (inputs) => harness.finishPurge(inputs["Dump"]),
      IngestSymbol: (inputs) => harness.ingestSymbol(inputs["Dump"]),
      Initialize: () => harness.initialize(),
      IssueToken: (inputs) => harness.issueToken(inputs["Token"]),
      MarkQuarantined: (inputs) => harness.markQuarantined(inputs["Dump"]),
      PromoteObject: (inputs) => harness.promoteObject(inputs["Dump"]),
      PurgeSymbol: (inputs) => harness.purgeSymbol(inputs["Dump"]),
      RejectDump: (inputs) => harness.rejectDump(inputs["Dump"]),
      ResolveCase: (inputs) => harness.resolveCase(inputs["Case"]),
      ResumeInvestigation: (inputs) => harness.resumeInvestigation(inputs["Case"]),
      RevokeToken: (inputs) => harness.revokeToken(inputs["Token"]),
      SealUpload: (inputs) => harness.sealUpload(inputs["Dump"]),
      StartInvestigation: (inputs) => harness.startInvestigation(inputs["Case"]),
      WaitForCustomer: (inputs) => harness.waitForCustomer(inputs["Case"]),
    },
    observe: () => {
      const observed = harness.observe();
      return {
        BlobState: observed.blobState,
        CaseStatus: observed.caseStatus,
        Coverage: observed.coverage,
        DigestRecorded: new Set(observed.digestRecorded),
        Downloadable: new Set(observed.downloadable),
        DumpCase: observed.dumpCase,
        DumpPhase: observed.dumpPhase,
        DumpToken: observed.dumpToken,
        SymbolRegistered: new Set(observed.symbolRegistered),
        TokenState: observed.tokenState,
        TokenUploads: observed.tokenUploads,
        Validation: observed.validation,
      } satisfies DumpLedgerNativeObservation;
    },
    dispose: () => harness.dispose(),
  };
}

/* ------------------------------- transfer ------------------------------- */

/** Wire variable name -> capitalized native observation id. */
const TRANSFER_NATIVE_KEYS: Record<string, string> = {
  blobState: "BlobState",
  bundle: "Bundle",
  caseDone: "CaseDone",
  caseStatus: "CaseStatus",
  coverage: "Coverage",
  custDone: "CustDone",
  digestRecorded: "DigestRecorded",
  done: "Done",
  downloadable: "Downloadable",
  dumpCase: "DumpCase",
  dumpPhase: "DumpPhase",
  dumpToken: "DumpToken",
  fingerprintMatches: "FingerprintMatches",
  symbolRegistered: "SymbolRegistered",
  tokDone: "TokDone",
  tokFirstDump: "TokFirstDump",
  tokenState: "TokenState",
  tokenUploads: "TokenUploads",
  validation: "Validation",
  wiped: "Wiped",
};

/** Minimal ITF-value decoder: the transfer harness observes wire values. */
type WireValue =
  | { readonly tag: "int"; readonly val: bigint }
  | { readonly tag: "bool"; readonly val: boolean }
  | { readonly tag: "str"; readonly val: string }
  | { readonly tag: "seq"; readonly val: readonly WireValue[] }
  | { readonly tag: "set"; readonly val: readonly WireValue[] }
  | { readonly tag: "record"; readonly val: { readonly [field: string]: WireValue } };

function decodeWire(value: WireValue): unknown {
  switch (value.tag) {
    case "int": return value.val;
    case "bool": return value.val;
    case "str": return value.val;
    case "seq": return value.val.map(decodeWire);
    case "set": return new Set(value.val.map(decodeWire));
    case "record": {
      const out: Record<string, unknown> = {};
      for (const [field, entry] of Object.entries(value.val)) out[field] = decodeWire(entry);
      return out;
    }
  }
}

export interface TransferSuiteAdapter extends DumpLedgerTransferNativeAdapter {
  readonly probe: TransferProbe;
  readonly harness: TransferMbtHarness;
}

export function createTransferSuiteAdapter(
  options: { readonly probe?: TransferProbe } = {},
): TransferSuiteAdapter {
  const probe = options.probe ?? createTransferProbe();
  const harness = new TransferMbtHarness(probe);
  return {
    probe,
    harness,
    actions: {
      AcceptDump: (inputs) => harness.acceptDump(inputs["Dump"], inputs["Kind"]),
      BeginPurge: (inputs) => harness.beginPurge(inputs["Dump"]),
      BeginUpload: (inputs) => harness.beginUpload(inputs["Token"], inputs["Dump"]),
      DeleteBundle: () => harness.deleteBundle(),
      ExportFail: () => harness.exportFail(),
      ExportSeal: () => harness.exportSeal(),
      ExportStart: () => harness.exportStart(),
      FinishPurge: (inputs) => harness.finishPurge(inputs["Dump"]),
      ImportCase: (inputs) => harness.importCase(inputs["Case"]),
      ImportCustomer: (inputs) => harness.importCustomer(inputs["Case"]),
      ImportDumpOk: (inputs) => harness.importDump(inputs["Dump"], inputs["Case"]),
      ImportDumpReject: (inputs) => harness.importDump(inputs["Dump"], inputs["Case"]),
      ImportDumpTombD: (inputs) => harness.importDump(inputs["Dump"], inputs["Case"]),
      ImportDumpTombR: (inputs) => harness.importDump(inputs["Dump"], inputs["Case"]),
      ImportFinish: () => harness.importFinish(),
      ImportHardFail: () => harness.importHardFail(),
      ImportStart: () => harness.importStart(),
      ImportTokens: (inputs) => harness.importTokens(inputs["Token"]),
      Initialize: (inputs) => harness.initialize(inputs["FingerprintMatches"]),
      IssueToken: (inputs) => harness.issueToken(inputs["Token"]),
      MarkQuarantined: (inputs) => harness.markQuarantined(inputs["Dump"]),
      PromoteObject: (inputs) => harness.promoteObject(inputs["Dump"]),
      RejectDump: (inputs) => harness.rejectDump(inputs["Dump"]),
      SealUpload: (inputs) => harness.sealUpload(inputs["Dump"]),
      TamperBundle: (inputs) => harness.tamperBundle(inputs["Dump"]),
      WipeInstance: () => harness.wipeInstance(),
    },
    observe: () => {
      const wire = harness.observe() as unknown as Record<string, WireValue>;
      const decoded: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(wire)) {
        const nativeKey = TRANSFER_NATIVE_KEYS[key];
        if (nativeKey !== undefined) decoded[nativeKey] = decodeWire(value);
      }
      return decoded as unknown as DumpLedgerTransferNativeObservation;
    },
    dispose: () => harness.dispose(),
  };
}
