/**
 * Handwritten MirrorECMA low-level StateComputer for DumpLedgerTransfer.tla.
 *
 * The computer drives the real transfer pipeline (export/import sessions plus
 * the engine's lifecycle commands) and reports the actual SUT state after
 * every model step. It is deliberately not a generated binding: dispatch and
 * state encoding live here (MirrorECMA "low-level customization"), and the
 * reported state carries every model variable except the wire variables
 * action_taken/parameters (paramVars are omitted from report_state by rule
 * of the trace-replay protocol).
 *
 * Observation provenance:
 * - lifecycle variables come from the live engine projection (same mapping
 *   as the base DumpLedger harness);
 * - the bundle record comes from the real export session's frozen selection
 *   (manifest + consistent snapshot) and the adapter's record of the tamper,
 *   delete, and wipe operations it actually performed;
 * - the done-sets are the import session's actual per-record progress;
 * - wiped/fingerprintMatches are the instance configuration the adapter
 *   installed (which grant key each instance generation uses); the policy
 *   itself is exercised for real by the import's forced-revocation path.
 */

import { createHash } from "node:crypto";
import { closeSync, fsyncSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ReplayComputer, State, Value } from "mirrorecma";
import { getParam } from "mirrorecma";

import type { CaseId, CustomerId, DumpId, GrantId } from "../domain/ids.js";
import type { CoverageKind } from "../domain/lifecycle.js";
import {
  createDumpLedgerEngine,
  DeterministicClock,
  DeterministicEntropy,
  DeterministicIds,
  type DumpLedgerEngine,
  type LifecycleCommand,
} from "../engine/dump-ledger-engine.js";
import type { InspectionOutcome, InspectionPort } from "../engine/inspection-port.js";
import type { DumpLedgerProjection, TransitionSuccess } from "../engine/projection.js";
import {
  createExportSession,
  fileBundleTarget,
  type ExportSession,
} from "../transfer/export.js";
import {
  openImportSession,
  type ImportSession,
} from "../transfer/import.js";
import { dumpEntryName } from "../transfer/manifest.js";
import { parseTarSize } from "../transfer/tar.js";
import { MemoryVault } from "../vault/memory-vault.js";
import type { Vault } from "../vault/vault.js";

const MODEL_SLOTS = [1n, 2n] as const;
const CASE_SLOTS = [1n, 2n] as const;
const NO_COVERAGE = "unclassified";
const DEFAULT_UPLOAD_BYTES = new TextEncoder().encode("DumpLedger model-based test payload");
const EXPORT_KEY = new Uint8Array(32).fill(0x44);
const OTHER_KEY = new Uint8Array(32).fill(0x55);

export interface TransferProbe {
  initializeCalls: number;
  actionCalls: number;
  observeCalls: number;
  sessionCreates: number;
  sessionCloses: number;
  disposeCalls: number;
  readonly actionCounts: Map<string, number>;
  readonly events: string[];
}

export function createTransferProbe(): TransferProbe {
  return {
    initializeCalls: 0,
    actionCalls: 0,
    observeCalls: 0,
    sessionCreates: 0,
    sessionCloses: 0,
    disposeCalls: 0,
    actionCounts: new Map(),
    events: [],
  };
}

interface ControlledInspector extends InspectionPort {
  accept(coverage: CoverageKind): void;
  reject(): void;
}

class ScriptedInspector implements ControlledInspector {
  private outcome: InspectionOutcome = {
    ok: false,
    error: "inspection outcome was not configured",
  };

  accept(coverage: CoverageKind): void {
    this.outcome = {
      ok: true,
      coverage,
      facts: { source: "transfer-mbt-scripted-inspector" },
    };
  }

  reject(): void {
    this.outcome = {
      ok: false,
      error: "scripted structural validation failure",
    };
  }

  inspect(_dumpId: DumpId): InspectionOutcome {
    return this.outcome;
  }
}

interface Instance {
  readonly engine: DumpLedgerEngine;
  readonly vault: Vault;
  readonly inspector: ScriptedInspector;
}

interface ExportRecord {
  readonly session: ExportSession;
  readonly bundlePath: string | null;
  status: "running" | "sealed" | "failed";
}

interface ImportRecord {
  readonly session: ImportSession;
  status: "importing" | "finished" | "import-failed";
}

function slot(value: bigint, label: string): 1n | 2n {
  if (value !== 1n && value !== 2n) {
    throw new RangeError(`${label} slot must be 1 or 2`);
  }
  return value;
}

function requireSuccess(
  receipt: ReturnType<DumpLedgerEngine["execute"]>,
): TransitionSuccess {
  if (!receipt.ok) {
    throw new Error(
      `${receipt.action} failed: ${receipt.error.code}: ${receipt.error.message}`,
    );
  }
  return receipt;
}

function requireResult<T>(value: T | undefined, label: string): T {
  if (value === undefined) {
    throw new Error(`${label} was not returned by the production engine`);
  }
  return value;
}

function vInt(value: bigint): Value {
  return { tag: "int", val: value };
}

function vBool(value: boolean): Value {
  return { tag: "bool", val: value };
}

function vStr(value: string): Value {
  return { tag: "str", val: value };
}

function vSeqStr(values: readonly string[]): Value {
  return { tag: "seq", val: values.map(vStr) };
}

function vSeqInt(values: readonly bigint[]): Value {
  return { tag: "seq", val: values.map(vInt) };
}

function vSetInt(values: ReadonlySet<bigint>): Value {
  const sorted = [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return { tag: "set", val: sorted.map(vInt) };
}

/** Flips the middle byte of one tar entry's data region in place (ustar). */
function tamperTarEntry(bundlePath: string, entryName: string): void {
  const descriptor = openSync(bundlePath, "r+");
  try {
    const header = Buffer.alloc(512);
    let offset = 0;
    for (;;) {
      if (readSync(descriptor, header, 0, 512, offset) < 512) break;
      if (header.every((byte) => byte === 0)) break;
      const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
      const size = Number(parseTarSize(header.subarray(124, 136)));
      if (name === entryName) {
        if (size === 0) throw new Error(`bundle entry ${entryName} is empty; nothing safe to flip`);
        const flipAt = offset + 512 + Math.floor(size / 2);
        const byte = Buffer.alloc(1);
        readSync(descriptor, byte, 0, 1, flipAt);
        byte[0] = (byte[0] as number) ^ 0xff;
        writeSync(descriptor, byte, 0, 1, flipAt);
        fsyncSync(descriptor);
        return;
      }
      offset += 512 + Math.ceil(size / 512) * 512;
    }
    throw new Error(`bundle entry ${entryName} was not found in ${bundlePath}`);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Session-local production composition behind the handwritten transfer
 * StateComputer. It contains no expected model state.
 */
export class TransferMbtHarness {
  private instance: Instance | undefined;
  private exportsDir: string | undefined;
  private customers: readonly [CustomerId, CustomerId] | undefined;
  private cases: readonly [CaseId, CaseId] | undefined;
  private readonly grants = new Map<bigint, { readonly grantId: GrantId; readonly secret: string }>();
  private readonly dumps = new Map<bigint, DumpId>();
  private readonly dumpToSlot = new Map<DumpId, bigint>();
  private readonly caseToSlot = new Map<CaseId, bigint>();
  private readonly customerToSlot = new Map<CustomerId, bigint>();
  private readonly grantToSlot = new Map<GrantId, bigint>();
  private exportRecord: ExportRecord | undefined;
  private importRecord: ImportRecord | undefined;
  private tampered: bigint = 0n;
  private wiped = false;
  private fingerprintMatches = true;
  private importKey: Uint8Array = EXPORT_KEY;
  private custDone = new Set<bigint>();
  private caseDone = new Set<bigint>();
  private done = new Set<bigint>();
  private tokDone = new Set<bigint>();
  private disposed = false;

  constructor(private readonly probe: TransferProbe) {}

  initialize(matches: boolean): void {
    if (this.disposed) throw new Error("transfer MBT harness is disposed");
    this.closeInstance();
    this.provideCleanExportsDir();
    this.probe.initializeCalls += 1;
    this.fingerprintMatches = matches;
    this.importKey = matches ? EXPORT_KEY : OTHER_KEY;
    this.wiped = false;
    this.exportRecord = undefined;
    this.importRecord = undefined;
    this.tampered = 0n;
    this.custDone = new Set();
    this.caseDone = new Set();
    this.done = new Set();
    this.tokDone = new Set();
    this.grants.clear();
    this.dumps.clear();
    this.dumpToSlot.clear();
    this.caseToSlot.clear();
    this.customerToSlot.clear();
    this.grantToSlot.clear();

    const instance = this.createInstance(EXPORT_KEY, 0);
    this.probe.sessionCreates += 1;
    try {
      const customerOne = requireResult(this.executeOn(instance.engine, {
        type: "CreateCustomer",
        displayName: "Model customer 1",
      }).customerId, "customerId");
      const caseOne = requireResult(this.executeOn(instance.engine, {
        type: "CreateCase",
        customerId: customerOne,
        title: "Model case 1",
      }).caseId, "caseId");
      const customerTwo = requireResult(this.executeOn(instance.engine, {
        type: "CreateCustomer",
        displayName: "Model customer 2",
      }).customerId, "customerId");
      const caseTwo = requireResult(this.executeOn(instance.engine, {
        type: "CreateCase",
        customerId: customerTwo,
        title: "Model case 2",
      }).caseId, "caseId");

      this.customers = [customerOne, customerTwo];
      this.cases = [caseOne, caseTwo];
      this.customerToSlot.set(customerOne, 1n).set(customerTwo, 2n);
      this.caseToSlot.set(caseOne, 1n).set(caseTwo, 2n);
      this.instance = instance;
    } catch (error) {
      instance.engine.close();
      this.probe.sessionCloses += 1;
      throw error;
    }
  }

  /* ------------------------- base lifecycle path ------------------------ */

  issueToken(tokenValue: bigint): void {
    const token = slot(tokenValue, "token");
    if (this.grants.has(token)) {
      throw new Error(`token slot ${token} was already issued`);
    }
    const receipt = this.execute({
      type: "IssueGrant",
      caseId: this.cases![Number(token - 1n)]!,
      expiresAt: "2099-01-01T00:00:00.000Z",
      maxBytes: 1024n,
    });
    const grantId = requireResult(receipt.grantId, "grantId");
    this.grants.set(token, {
      grantId,
      secret: requireResult(receipt.grantSecret, "grantSecret"),
    });
    this.grantToSlot.set(grantId, token);
  }

  beginUpload(tokenValue: bigint, dumpValue: bigint): void {
    const dump = slot(dumpValue, "dump");
    if (this.dumps.has(dump)) {
      throw new Error(`dump slot ${dump} was already allocated`);
    }
    const grant = this.requireGrant(tokenValue);
    const receipt = this.execute({
      type: "BeginUpload",
      grantSecret: grant.secret,
      originalName: `model-dump-${dump}.dmp`,
    });
    const dumpId = requireResult(receipt.dumpId, "dumpId");
    this.dumps.set(dump, dumpId);
    this.dumpToSlot.set(dumpId, dump);
  }

  sealUpload(dumpValue: bigint): void {
    const dumpId = this.requireDump(dumpValue);
    const sha256 = createHash("sha256").update(DEFAULT_UPLOAD_BYTES).digest("hex");
    this.requireInstance().vault.append(dumpId, DEFAULT_UPLOAD_BYTES);
    this.requireInstance().vault.syncAndClose(dumpId);
    this.execute({
      type: "SealUpload",
      dumpId,
      byteSize: BigInt(DEFAULT_UPLOAD_BYTES.byteLength),
      sha256,
    });
  }

  promoteObject(dumpValue: bigint): void {
    this.execute({ type: "PromoteObject", dumpId: this.requireDump(dumpValue) });
  }

  markQuarantined(dumpValue: bigint): void {
    this.execute({ type: "MarkQuarantined", dumpId: this.requireDump(dumpValue) });
  }

  acceptDump(dumpValue: bigint, kind: string): void {
    const dumpId = this.requireDump(dumpValue);
    if (kind !== "partial" && kind !== "full-memory-declared" && kind !== "unknown") {
      throw new RangeError(`coverage kind is outside the model universe: ${kind}`);
    }
    this.requireInstance().inspector.accept(kind);
    this.execute({ type: "AcceptDump", dumpId });
  }

  rejectDump(dumpValue: bigint): void {
    this.requireInstance().inspector.reject();
    this.execute({ type: "RejectDump", dumpId: this.requireDump(dumpValue) });
  }

  beginPurge(dumpValue: bigint): void {
    this.execute({ type: "BeginPurge", dumpId: this.requireDump(dumpValue) });
  }

  finishPurge(dumpValue: bigint): void {
    this.execute({ type: "FinishPurge", dumpId: this.requireDump(dumpValue) });
  }

  /* --------------------------- transfer path ---------------------------- */

  async exportStart(): Promise<void> {
    if (this.exportRecord !== undefined) {
      throw new Error("an export is already tracked");
    }
    this.importRecord = undefined;
    this.tampered = 0n;
    this.custDone = new Set();
    this.caseDone = new Set();
    this.done = new Set();
    this.tokDone = new Set();
    const instance = this.requireInstance();
    let armed = false;
    const session = await createExportSession({
      engine: instance.engine,
      vault: instance.vault,
      exportsDir: this.requireExportsDir(),
      targetFactory: (paths) => {
        const real = fileBundleTarget(paths);
        return {
          sink: {
            write: (bytes) => {
              if (armed) throw new Error("injected mid-copy export failure");
              real.sink.write(bytes);
            },
          },
          seal: () => real.seal(),
          discard: () => real.discard(),
        };
      },
    });
    this.exportRecord = {
      session,
      bundlePath: join(session.exportDir, "bundle.tar"),
      status: "running",
    };
    this.exportFaultArmer = () => {
      armed = true;
    };
  }

  private exportFaultArmer: (() => void) | undefined;

  async exportSeal(): Promise<void> {
    const record = this.requireExport("running");
    const summary = await record.session.run();
    if (summary.status !== "sealed") {
      throw new Error(`export did not seal: ${summary.error ?? "unknown error"}`);
    }
    record.status = "sealed";
  }

  async exportFail(): Promise<void> {
    const record = this.requireExport("running");
    this.exportFaultArmer?.();
    const summary = await record.session.run();
    if (summary.status !== "failed") {
      throw new Error("export unexpectedly sealed with the injected fault armed");
    }
    record.status = "failed";
  }

  tamperBundle(dumpValue: bigint): void {
    const dump = slot(dumpValue, "dump");
    const record = this.requireExport("sealed");
    if (record.bundlePath === null) throw new Error("sealed bundle path is unknown");
    tamperTarEntry(record.bundlePath, dumpEntryName(this.requireDump(dump)));
    this.tampered = dump;
  }

  deleteBundle(): void {
    const record = this.requireExportRecord();
    rmSync(record.session.exportDir, { recursive: true, force: true });
    this.exportRecord = undefined;
    this.tampered = 0n;
  }

  wipeInstance(): void {
    const instance = this.requireInstance();
    instance.engine.close();
    this.probe.sessionCloses += 1;
    this.instance = this.createInstance(this.importKey, 1);
    this.probe.sessionCreates += 1;
    this.wiped = true;
    this.importRecord = undefined;
    this.custDone = new Set();
    this.caseDone = new Set();
    this.done = new Set();
    this.tokDone = new Set();
    /* Slot maps persist: the transfer preserves every real identifier, so the
       pre-wipe slot assignment stays valid for rows the import restores. */
  }

  importStart(): void {
    if (this.importRecord !== undefined) {
      throw new Error("an import is already tracked");
    }
    const record = this.requireExport("sealed");
    if (record.bundlePath === null) throw new Error("sealed bundle path is unknown");
    const instance = this.requireInstance();
    const session = openImportSession({
      engine: instance.engine,
      vault: instance.vault,
      bundlePath: record.bundlePath,
    });
    session.begin();
    this.importRecord = { session, status: "importing" };
    this.custDone = new Set();
    this.caseDone = new Set();
    this.done = new Set();
    this.tokDone = new Set();
  }

  importCustomer(customerValue: bigint): void {
    const customer = slot(customerValue, "customer");
    this.requireImport("importing").session.importCustomer(this.customers![Number(customer - 1n)]!);
    this.custDone.add(customer);
  }

  importCase(caseValue: bigint): void {
    const caseSlot = slot(caseValue, "case");
    this.requireImport("importing").session.importCase(this.cases![Number(caseSlot - 1n)]!);
    this.caseDone.add(caseSlot);
  }

  importTokens(tokenValue: bigint): void {
    const token = slot(tokenValue, "token");
    this.requireImport("importing").session.importGrant(this.requireGrant(token).grantId);
    this.tokDone.add(token);
  }

  importDump(dumpValue: bigint, caseValue: bigint): void {
    const dump = slot(dumpValue, "dump");
    slot(caseValue, "case");
    this.requireImport("importing").session.stageDump(this.requireDump(dump));
    this.done.add(dump);
  }

  importFinish(): void {
    const record = this.requireImport("importing");
    record.session.finish();
    record.status = "finished";
  }

  importHardFail(): void {
    const record = this.requireImport("importing");
    record.session.abandon();
    record.status = "import-failed";
  }

  /* ---------------------------- observation ----------------------------- */

  observe(): State {
    this.probe.observeCalls += 1;
    const projection = this.requireInstance().engine.snapshot();
    const grantBySlot = (modelSlot: bigint) => {
      const grant = this.grants.get(modelSlot);
      if (grant === undefined) return undefined;
      return projection.grants.find((candidate) => candidate.grantId === grant.grantId);
    };
    const dumpBySlot = (modelSlot: bigint) => {
      const dumpId = this.dumps.get(modelSlot);
      if (dumpId === undefined) return undefined;
      return projection.dumps.find((candidate) => candidate.dumpId === dumpId);
    };
    const caseBySlot = (modelSlot: bigint) => {
      const caseId = this.cases?.[Number(modelSlot - 1n)];
      if (caseId === undefined) return undefined;
      return projection.cases.find((candidate) => candidate.caseId === caseId);
    };

    const state: State = {
      caseStatus: vSeqStr(CASE_SLOTS.map((modelSlot) => {
        const found = caseBySlot(modelSlot);
        if (found === undefined) return "new";
        return found.status;
      })),
      tokenState: vSeqStr(MODEL_SLOTS.map((modelSlot) => grantBySlot(modelSlot)?.state ?? "unused")),
      tokenDump: vSeqInt(MODEL_SLOTS.map((modelSlot) => {
        const consumed = grantBySlot(modelSlot)?.consumedByDumpId;
        if (consumed === null || consumed === undefined) return 0n;
        const mapped = this.dumpToSlot.get(consumed);
        if (mapped === undefined) {
          throw new Error(`consumed dump ${consumed} has no model slot`);
        }
        return mapped;
      })),
      dumpPhase: vSeqStr(MODEL_SLOTS.map((modelSlot) => dumpBySlot(modelSlot)?.phase ?? "absent")),
      dumpCase: vSeqInt(MODEL_SLOTS.map((modelSlot) => {
        const caseId = dumpBySlot(modelSlot)?.caseId;
        if (caseId === undefined) return 0n;
        const mapped = this.caseToSlot.get(caseId);
        if (mapped === undefined) {
          throw new Error(`dump case ${caseId} has no model slot`);
        }
        return mapped;
      })),
      blobState: vSeqStr(MODEL_SLOTS.map((modelSlot) => dumpBySlot(modelSlot)?.blobState ?? "none")),
      digestRecorded: vSetInt(new Set(MODEL_SLOTS.filter((modelSlot) => {
        const sha256 = dumpBySlot(modelSlot)?.sha256;
        return sha256 !== null && sha256 !== undefined;
      }))),
      validation: vSeqStr(MODEL_SLOTS.map((modelSlot) => dumpBySlot(modelSlot)?.validation ?? "not-checked")),
      coverage: vSeqStr(MODEL_SLOTS.map((modelSlot) => dumpBySlot(modelSlot)?.coverage ?? NO_COVERAGE)),
      downloadable: vSetInt(new Set(projection.downloadable.map((realId) => {
        const mapped = this.dumpToSlot.get(realId);
        if (mapped === undefined) {
          throw new Error(`downloadable dump ${realId} has no model slot`);
        }
        return mapped;
      }))),
      wiped: vBool(this.wiped),
      fingerprintMatches: vBool(this.fingerprintMatches),
      bundle: this.observeBundle(),
      custDone: vSetInt(this.custDone),
      caseDone: vSetInt(this.caseDone),
      done: vSetInt(this.done),
      tokDone: vSetInt(this.tokDone),
    };
    return state;
  }

  private observeBundle(): Value {
    const record = this.exportRecord;
    if (record === undefined) {
      return this.noBundle();
    }
    const manifest = record.session.manifest;
    const slotSet = (phase: "available" | "rejected" | "deleted"): Set<bigint> => {
      const result = new Set<bigint>();
      for (const dump of manifest.dumps) {
        if (dump.phase !== phase) continue;
        const mapped = this.dumpToSlot.get(dump.dumpId);
        if (mapped === undefined) {
          throw new Error(`manifest dump ${dump.dumpId} has no model slot`);
        }
        result.add(mapped);
      }
      return result;
    };
    const snapshot = record.session.snapshot;
    const caseRow = (modelSlot: bigint) => {
      const caseId = this.cases?.[Number(modelSlot - 1n)];
      return caseId === undefined
        ? undefined
        : snapshot.cases.find((candidate) => candidate.caseId === caseId);
    };
    const grantRow = (modelSlot: bigint) => {
      const grant = this.grants.get(modelSlot);
      if (grant === undefined) return undefined;
      return snapshot.grants.find((candidate) => candidate.grantId === grant.grantId);
    };
    const dumpRow = (modelSlot: bigint) => {
      const dumpId = this.dumps.get(modelSlot);
      if (dumpId === undefined) return undefined;
      return snapshot.dumps.find((candidate) => candidate.dumpId === dumpId);
    };
    const status = this.importRecord !== undefined
      ? this.importRecord.status
      : record.status;
    return {
      tag: "record",
      val: {
        status: vStr(status === "running" ? "running" : status),
        promised: vSetInt(slotSet("available")),
        rejected: vSetInt(slotSet("rejected")),
        deleted: vSetInt(slotSet("deleted")),
        bad: vInt(this.tampered),
        cstat: vSeqStr(CASE_SLOTS.map((modelSlot) => caseRow(modelSlot)?.status ?? "new")),
        gstate: vSeqStr(MODEL_SLOTS.map((modelSlot) => grantRow(modelSlot)?.state ?? "unused")),
        gdump: vSeqInt(MODEL_SLOTS.map((modelSlot) => {
          const consumed = grantRow(modelSlot)?.consumedByDumpId;
          if (consumed === null || consumed === undefined) return 0n;
          const mapped = this.dumpToSlot.get(consumed);
          if (mapped === undefined) {
            throw new Error(`snapshot consumed dump ${consumed} has no model slot`);
          }
          return mapped;
        })),
        dcase: vSeqInt(MODEL_SLOTS.map((modelSlot) => {
          const row = dumpRow(modelSlot);
          if (row === undefined) return 0n;
          const mapped = this.caseToSlot.get(row.caseId);
          if (mapped === undefined) {
            throw new Error(`snapshot dump case ${row.caseId} has no model slot`);
          }
          return mapped;
        })),
        dcov: vSeqStr(MODEL_SLOTS.map((modelSlot) => {
          const row = dumpRow(modelSlot);
          if (row === undefined || row.phase !== "deleted") return NO_COVERAGE;
          return row.coverage ?? NO_COVERAGE;
        })),
      },
    };
  }

  private noBundle(): Value {
    return {
      tag: "record",
      val: {
        status: vStr("absent"),
        promised: vSetInt(new Set()),
        rejected: vSetInt(new Set()),
        deleted: vSetInt(new Set()),
        bad: vInt(0n),
        cstat: vSeqStr(["new", "new"]),
        gstate: vSeqStr(["unused", "unused"]),
        gdump: vSeqInt([0n, 0n]),
        dcase: vSeqInt([0n, 0n]),
        dcov: vSeqStr([NO_COVERAGE, NO_COVERAGE]),
      },
    };
  }

  /* ------------------------------ plumbing ------------------------------ */

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.probe.disposeCalls += 1;
    this.importRecord?.session.close();
    this.exportRecord?.session.discard();
    this.closeInstance();
    if (this.exportsDir !== undefined) {
      rmSync(this.exportsDir, { recursive: true, force: true });
      this.exportsDir = undefined;
    }
  }

  private createInstance(grantSecretKey: Uint8Array, generation: 0 | 1): Instance {
    const vault = new MemoryVault();
    const inspector = new ScriptedInspector();
    /* The wiped target is a fresh deployment: like real random ids/secrets,
       its deterministic id sequence and grant secrets must not collide with
       the source instance's (both would otherwise restart at zero). */
    const engine = createDumpLedgerEngine({
      databasePath: ":memory:",
      vault,
      inspection: inspector,
      grantSecretKey,
      clock: new DeterministicClock("2026-09-04T00:00:00.000Z"),
      entropy: new DeterministicEntropy(generation === 0
        ? [
          "dump-ledger-transfer-mbt-secret-1",
          "dump-ledger-transfer-mbt-secret-2",
        ]
        : [
          "dump-ledger-transfer-mbt-wiped-secret-1",
          "dump-ledger-transfer-mbt-wiped-secret-2",
        ]),
      ids: new DeterministicIds(generation === 0 ? 0 : 1_000_000),
    });
    return { engine, vault, inspector };
  }

  private provideCleanExportsDir(): void {
    if (this.exportsDir !== undefined) {
      rmSync(this.exportsDir, { recursive: true, force: true });
    }
    this.exportsDir = mkdtempSync(join(tmpdir(), "dump-ledger-transfer-mbt-"));
  }

  private execute(command: LifecycleCommand): TransitionSuccess {
    return this.executeOn(this.requireInstance().engine, command);
  }

  private executeOn(
    engine: DumpLedgerEngine,
    command: LifecycleCommand,
  ): TransitionSuccess {
    this.probe.events.push(`engine:${command.type}`);
    return requireSuccess(engine.execute(command));
  }

  private requireInstance(): Instance {
    if (this.instance === undefined) {
      throw new Error("transfer MBT harness has not been initialized");
    }
    return this.instance;
  }

  private requireExportsDir(): string {
    if (this.exportsDir === undefined) {
      throw new Error("transfer MBT harness has no exports directory");
    }
    return this.exportsDir;
  }

  private requireGrant(
    tokenValue: bigint,
  ): { readonly grantId: GrantId; readonly secret: string } {
    const token = slot(tokenValue, "token");
    const grant = this.grants.get(token);
    if (grant === undefined) {
      throw new Error(`token slot ${token} has not been issued`);
    }
    return grant;
  }

  private requireDump(dumpValue: bigint): DumpId {
    const dump = slot(dumpValue, "dump");
    const dumpId = this.dumps.get(dump);
    if (dumpId === undefined) {
      throw new Error(`dump slot ${dump} has not been allocated`);
    }
    return dumpId;
  }

  private requireExportRecord(): ExportRecord {
    if (this.exportRecord === undefined) {
      throw new Error("no export is tracked");
    }
    return this.exportRecord;
  }

  private requireExport(status: ExportRecord["status"]): ExportRecord {
    const record = this.requireExportRecord();
    if (record.status !== status) {
      throw new Error(`export is ${record.status}, expected ${status}`);
    }
    return record;
  }

  private requireImport(status: ImportRecord["status"]): ImportRecord {
    if (this.importRecord === undefined || this.importRecord.status !== status) {
      throw new Error(`import is ${this.importRecord?.status ?? "absent"}, expected ${status}`);
    }
    return this.importRecord;
  }

  private closeInstance(): void {
    if (this.instance === undefined) return;
    this.instance.engine.close();
    this.instance = undefined;
    this.probe.sessionCloses += 1;
  }
}

function requireParameters(params: State): { case_: bigint; token: bigint; dump: bigint; kind: string } {
  const record = getParam(params, "parameters");
  if (record === null) throw new Error("next_step carried no parameters record");
  const read = (field: string): bigint => {
    const value = record[field];
    if (value?.tag !== "int") throw new Error(`parameters.${field} is not an integer`);
    return value.val;
  };
  const kind = record["kind"];
  if (kind?.tag !== "str") throw new Error("parameters.kind is not a string");
  return { case_: read("case"), token: read("token"), dump: read("dump"), kind: kind.val };
}

/**
 * The handwritten StateComputer: one fresh harness per Init (the mirror
 * starts every trace with initial_state), dispatching each wire action to
 * the real SUT and reporting the actual observed state afterwards.
 */
export function createTransferReplayComputer(
  probe: TransferProbe,
  harness?: TransferMbtHarness,
): { readonly computer: ReplayComputer; readonly harness: TransferMbtHarness } {
  const owned = harness ?? new TransferMbtHarness(probe);
  const computer: ReplayComputer = async (action, params, _prevState) => {
    if (action === "Init") {
      const matches = params["fingerprintMatches"];
      if (matches?.tag !== "bool") {
        throw new Error("initial state carried no fingerprintMatches boolean");
      }
      owned.initialize(matches.val);
      return owned.observe();
    }
    probe.actionCalls += 1;
    probe.actionCounts.set(action, (probe.actionCounts.get(action) ?? 0) + 1);
    const inputs = requireParameters(params);
    switch (action) {
      case "IssueToken": owned.issueToken(inputs.token); break;
      case "BeginUpload": owned.beginUpload(inputs.token, inputs.dump); break;
      case "SealUpload": owned.sealUpload(inputs.dump); break;
      case "PromoteObject": owned.promoteObject(inputs.dump); break;
      case "MarkQuarantined": owned.markQuarantined(inputs.dump); break;
      case "AcceptDump": owned.acceptDump(inputs.dump, inputs.kind); break;
      case "RejectDump": owned.rejectDump(inputs.dump); break;
      case "BeginPurge": owned.beginPurge(inputs.dump); break;
      case "FinishPurge": owned.finishPurge(inputs.dump); break;
      case "ExportStart": await owned.exportStart(); break;
      case "ExportSeal": await owned.exportSeal(); break;
      case "ExportFail": await owned.exportFail(); break;
      case "TamperBundle": owned.tamperBundle(inputs.dump); break;
      case "DeleteBundle": owned.deleteBundle(); break;
      case "WipeInstance": owned.wipeInstance(); break;
      case "ImportStart": owned.importStart(); break;
      case "ImportCustomer": owned.importCustomer(inputs.case_); break;
      case "ImportCase": owned.importCase(inputs.case_); break;
      case "ImportTokens": owned.importTokens(inputs.token); break;
      case "ImportDumpOk":
      case "ImportDumpReject":
      case "ImportDumpTombR":
      case "ImportDumpTombD":
        owned.importDump(inputs.dump, inputs.case_);
        break;
      case "ImportFinish": owned.importFinish(); break;
      case "ImportHardFail": owned.importHardFail(); break;
      default: throw new Error(`unknown wire action: ${action}`);
    }
    probe.events.push(`port:${action}`);
    return owned.observe();
  };
  return { computer, harness: owned };
}
