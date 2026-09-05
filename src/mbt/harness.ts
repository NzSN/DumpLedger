import { createHash } from "node:crypto";

import type { CaseId, DumpId, GrantId } from "../domain/ids.js";
import { isCoverageKind, type CoverageKind } from "../domain/lifecycle.js";
import {
  createDumpLedgerEngine,
  DeterministicClock,
  DeterministicEntropy,
  DeterministicIds,
  type DumpLedgerEngine,
  type LifecycleCommand,
} from "../engine/dump-ledger-engine.js";
import type { InspectionOutcome, InspectionPort } from "../engine/inspection-port.js";
import type { TransitionSuccess } from "../engine/projection.js";
import type {
  AcceptDumpInput,
  BeginPurgeInput,
  BeginUploadInput,
  DumpLedgerBinding,
  DumpLedgerObservation,
  DumpLedgerPort,
  ExpireTokenInput,
  FailUploadInput,
  FinishPurgeInput,
  IssueTokenInput,
  MarkQuarantinedInput,
  PromoteObjectInput,
  RejectDumpInput,
  RevokeTokenInput,
  SealUploadInput,
} from "../generated/dump-ledger/DumpLedgerMirror.generated.js";
import { createVaultMinidumpInspectionPort } from "../inspection/index.js";
import { MemoryVault } from "../vault/memory-vault.js";
import type { Vault } from "../vault/vault.js";

const MODEL_SLOTS = [1n, 2n] as const;
const DEFAULT_UPLOAD_BYTES = new TextEncoder().encode("DumpLedger model-based test payload");

export interface MbtProbe {
  factoryCalls: number;
  portCalls: number;
  engineCalls: number;
  observationCalls: number;
  bindingDisposeCalls: number;
  harnessDisposeCalls: number;
  sessionCreates: number;
  sessionCloses: number;
  generatedBinding?: DumpLedgerBinding;
  readonly events: string[];
}

export function createMbtProbe(): MbtProbe {
  return {
    factoryCalls: 0,
    portCalls: 0,
    engineCalls: 0,
    observationCalls: 0,
    bindingDisposeCalls: 0,
    harnessDisposeCalls: 0,
    sessionCreates: 0,
    sessionCloses: 0,
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
      facts: { source: "mbt-scripted-inspector" },
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

class ProductionInspector implements ControlledInspector {
  private readonly delegate: InspectionPort;

  constructor(vault: Vault) {
    this.delegate = createVaultMinidumpInspectionPort(vault);
  }

  accept(_coverage: CoverageKind): void {}
  reject(): void {}

  inspect(dumpId: DumpId): InspectionOutcome {
    return this.delegate.inspect(dumpId);
  }
}

interface Session {
  readonly engine: DumpLedgerEngine;
  readonly vault: Vault;
  readonly inspector: ControlledInspector;
  readonly cases: readonly [CaseId, CaseId];
  readonly grants: Map<bigint, { readonly grantId: GrantId; readonly secret: string }>;
  readonly dumps: Map<bigint, DumpId>;
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

function assertNoPromiseLike(value: unknown, path = "observation"): void {
  if (typeof value !== "object" || value === null) return;
  if ("then" in value && typeof (value as { then?: unknown }).then === "function") {
    throw new TypeError(`${path} must be synchronous`);
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoPromiseLike(item, `${path}[${index}]`));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    assertNoPromiseLike(item, `${path}.${key}`);
  }
}

export interface MbtHarnessOptions {
  readonly vaultFactory?: () => Vault;
  readonly uploadBytes?: Uint8Array;
  readonly productionInspection?: boolean;
}

/**
 * Session-local production composition used by the generated model port.
 * It contains no expected model state and is deliberately not passed prevState.
 */
export class MbtHarness {
  private session: Session | undefined;
  private disposed = false;

  constructor(
    private readonly probe: MbtProbe,
    private readonly options: MbtHarnessOptions = {},
  ) {}

  initialize(): void {
    if (this.disposed) throw new Error("MBT harness is disposed");
    this.closeSession();

    const vault = this.options.vaultFactory?.() ?? new MemoryVault();
    const inspector = this.options.productionInspection === true
      ? new ProductionInspector(vault)
      : new ScriptedInspector();
    const engine = createDumpLedgerEngine({
      databasePath: ":memory:",
      vault,
      inspection: inspector,
      grantSecretKey: new Uint8Array(32).fill(0x44),
      clock: new DeterministicClock("2026-09-04T00:00:00.000Z"),
      entropy: new DeterministicEntropy([
        "dump-ledger-mbt-secret-token-1",
        "dump-ledger-mbt-secret-token-2",
      ]),
      ids: new DeterministicIds(),
    });
    this.probe.sessionCreates += 1;

    try {
      const customerOne = requireResult(this.executeOn(engine, {
        type: "CreateCustomer",
        displayName: "Model customer 1",
      }).customerId, "customerId");
      const caseOne = requireResult(this.executeOn(engine, {
        type: "CreateCase",
        customerId: customerOne,
        title: "Model case 1",
      }).caseId, "caseId");
      const customerTwo = requireResult(this.executeOn(engine, {
        type: "CreateCustomer",
        displayName: "Model customer 2",
      }).customerId, "customerId");
      const caseTwo = requireResult(this.executeOn(engine, {
        type: "CreateCase",
        customerId: customerTwo,
        title: "Model case 2",
      }).caseId, "caseId");

      this.session = {
        engine,
        vault,
        inspector,
        cases: [caseOne, caseTwo],
        grants: new Map(),
        dumps: new Map(),
      };
    } catch (error) {
      engine.close();
      this.probe.sessionCloses += 1;
      throw error;
    }
  }

  issueToken(tokenValue: bigint): void {
    const token = slot(tokenValue, "token");
    const session = this.requireSession();
    if (session.grants.has(token)) {
      throw new Error(`token slot ${token} was already issued`);
    }
    const receipt = this.execute({
      type: "IssueGrant",
      caseId: session.cases[Number(token - 1n)]!,
      expiresAt: "2099-01-01T00:00:00.000Z",
      maxBytes: 1024n,
    });
    session.grants.set(token, {
      grantId: requireResult(receipt.grantId, "grantId"),
      secret: requireResult(receipt.grantSecret, "grantSecret"),
    });
  }

  revokeToken(tokenValue: bigint): void {
    this.execute({
      type: "RevokeGrant",
      grantId: this.requireGrant(tokenValue).grantId,
    });
  }

  expireToken(tokenValue: bigint): void {
    this.execute({
      type: "ExpireGrant",
      grantId: this.requireGrant(tokenValue).grantId,
    });
  }

  beginUpload(tokenValue: bigint, dumpValue: bigint): void {
    const dump = slot(dumpValue, "dump");
    const session = this.requireSession();
    if (session.dumps.has(dump)) {
      throw new Error(`dump slot ${dump} was already allocated`);
    }
    const grant = this.requireGrant(tokenValue);
    const receipt = this.execute({
      type: "BeginUpload",
      grantSecret: grant.secret,
      originalName: `model-dump-${dump}.dmp`,
    });
    session.dumps.set(dump, requireResult(receipt.dumpId, "dumpId"));
  }

  sealUpload(dumpValue: bigint): void {
    const session = this.requireSession();
    const dumpId = this.requireDump(dumpValue);
    const uploadBytes = this.options.uploadBytes ?? DEFAULT_UPLOAD_BYTES;
    const sha256 = createHash("sha256").update(uploadBytes).digest("hex");
    session.vault.append(dumpId, uploadBytes);
    session.vault.syncAndClose(dumpId);
    this.execute({
      type: "SealUpload",
      dumpId,
      byteSize: BigInt(uploadBytes.byteLength),
      sha256,
    });
  }

  failUpload(dumpValue: bigint): void {
    this.execute({
      type: "FailUpload",
      dumpId: this.requireDump(dumpValue),
    });
  }

  promoteObject(dumpValue: bigint): void {
    this.execute({
      type: "PromoteObject",
      dumpId: this.requireDump(dumpValue),
    });
  }

  markQuarantined(dumpValue: bigint): void {
    this.execute({
      type: "MarkQuarantined",
      dumpId: this.requireDump(dumpValue),
    });
  }

  acceptDump(dumpValue: bigint, kind: string): void {
    if (!isCoverageKind(kind)) {
      throw new RangeError(`unsupported coverage kind ${kind}`);
    }
    const session = this.requireSession();
    session.inspector.accept(kind);
    this.execute({
      type: "AcceptDump",
      dumpId: this.requireDump(dumpValue),
    });
  }

  rejectDump(dumpValue: bigint): void {
    const session = this.requireSession();
    session.inspector.reject();
    this.execute({
      type: "RejectDump",
      dumpId: this.requireDump(dumpValue),
    });
  }

  beginPurge(dumpValue: bigint): void {
    this.execute({
      type: "BeginPurge",
      dumpId: this.requireDump(dumpValue),
    });
  }

  finishPurge(dumpValue: bigint): void {
    this.execute({
      type: "FinishPurge",
      dumpId: this.requireDump(dumpValue),
    });
  }

  observe(): DumpLedgerObservation {
    const session = this.requireSession();
    const projection = session.engine.snapshot();
    const grantBySlot = (token: bigint) => {
      const mapped = session.grants.get(token);
      if (mapped === undefined) return undefined;
      const grant = projection.grants.find(
        (candidate) => candidate.grantId === mapped.grantId,
      );
      if (grant === undefined) {
        throw new Error(`mapped token slot ${token} is missing from the ledger`);
      }
      return grant;
    };
    const dumpBySlot = (dump: bigint) => {
      const mapped = session.dumps.get(dump);
      if (mapped === undefined) return undefined;
      const found = projection.dumps.find(
        (candidate) => candidate.dumpId === mapped,
      );
      if (found === undefined) {
        throw new Error(`mapped dump slot ${dump} is missing from the ledger`);
      }
      return found;
    };
    const reverseDump = new Map(
      [...session.dumps].map(([modelSlot, realId]) => [realId, modelSlot]),
    );
    const reverseCase = new Map(
      session.cases.map((realId, index) => [realId, BigInt(index + 1)]),
    );

    const observation: DumpLedgerObservation = {
      tokenState: MODEL_SLOTS.map(
        (modelSlot) => grantBySlot(modelSlot)?.state ?? "unused",
      ),
      tokenDump: MODEL_SLOTS.map((modelSlot) => {
        const consumed = grantBySlot(modelSlot)?.consumedByDumpId;
        if (consumed === null || consumed === undefined) return 0n;
        const mapped = reverseDump.get(consumed);
        if (mapped === undefined) {
          throw new Error(`consumed dump ${consumed} has no model slot`);
        }
        return mapped;
      }),
      dumpPhase: MODEL_SLOTS.map(
        (modelSlot) => dumpBySlot(modelSlot)?.phase ?? "absent",
      ),
      dumpCase: MODEL_SLOTS.map((modelSlot) => {
        const caseId = dumpBySlot(modelSlot)?.caseId;
        if (caseId === undefined) return 0n;
        const mapped = reverseCase.get(caseId);
        if (mapped === undefined) {
          throw new Error(`dump case ${caseId} has no model slot`);
        }
        return mapped;
      }),
      blobState: MODEL_SLOTS.map(
        (modelSlot) => dumpBySlot(modelSlot)?.blobState ?? "none",
      ),
      digestRecorded: MODEL_SLOTS.filter((modelSlot) => {
        const sha256 = dumpBySlot(modelSlot)?.sha256;
        return sha256 !== null && sha256 !== undefined;
      }),
      validation: MODEL_SLOTS.map(
        (modelSlot) => dumpBySlot(modelSlot)?.validation ?? "not-checked",
      ),
      coverage: MODEL_SLOTS.map(
        (modelSlot) => dumpBySlot(modelSlot)?.coverage ?? "unclassified",
      ),
      downloadable: projection.downloadable
        .map((realId) => {
          const mapped = reverseDump.get(realId);
          if (mapped === undefined) {
            throw new Error(`downloadable dump ${realId} has no model slot`);
          }
          return mapped;
        })
        .sort((left, right) => Number(left - right)),
    };
    assertNoPromiseLike(observation);
    return observation;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.probe.harnessDisposeCalls += 1;
    this.closeSession();
  }

  private execute(command: LifecycleCommand): TransitionSuccess {
    return this.executeOn(this.requireSession().engine, command);
  }

  private executeOn(
    engine: DumpLedgerEngine,
    command: LifecycleCommand,
  ): TransitionSuccess {
    this.probe.engineCalls += 1;
    this.probe.events.push(`engine:${command.type}`);
    return requireSuccess(engine.execute(command));
  }

  private requireSession(): Session {
    if (this.session === undefined) {
      throw new Error("MBT harness has not been initialized");
    }
    return this.session;
  }

  private requireGrant(
    tokenValue: bigint,
  ): { readonly grantId: GrantId; readonly secret: string } {
    const token = slot(tokenValue, "token");
    const grant = this.requireSession().grants.get(token);
    if (grant === undefined) {
      throw new Error(`token slot ${token} has not been issued`);
    }
    return grant;
  }

  private requireDump(dumpValue: bigint): DumpId {
    const dump = slot(dumpValue, "dump");
    const dumpId = this.requireSession().dumps.get(dump);
    if (dumpId === undefined) {
      throw new Error(`dump slot ${dump} has not been allocated`);
    }
    return dumpId;
  }

  private closeSession(): void {
    if (this.session === undefined) return;
    this.session.engine.close();
    this.session = undefined;
    this.probe.sessionCloses += 1;
  }
}

/** The sole handwritten implementation of the compiler-generated port. */
export class DumpLedgerMbtPort implements DumpLedgerPort {
  constructor(
    private readonly harness: MbtHarness,
    private readonly probe: MbtProbe,
    private readonly mutateObservation?: (
      observation: DumpLedgerObservation,
    ) => DumpLedgerObservation,
  ) {}

  initialize(): void {
    this.call("Initialize", () => this.harness.initialize());
  }
  acceptDump(input: AcceptDumpInput): void {
    this.call("AcceptDump", () => this.harness.acceptDump(input.dump, input.kind));
  }
  beginPurge(input: BeginPurgeInput): void {
    this.call("BeginPurge", () => this.harness.beginPurge(input.dump));
  }
  beginUpload(input: BeginUploadInput): void {
    this.call("BeginUpload", () => this.harness.beginUpload(input.token, input.dump));
  }
  expireToken(input: ExpireTokenInput): void {
    this.call("ExpireToken", () => this.harness.expireToken(input.token));
  }
  failUpload(input: FailUploadInput): void {
    this.call("FailUpload", () => this.harness.failUpload(input.dump));
  }
  finishPurge(input: FinishPurgeInput): void {
    this.call("FinishPurge", () => this.harness.finishPurge(input.dump));
  }
  issueToken(input: IssueTokenInput): void {
    this.call("IssueToken", () => this.harness.issueToken(input.token));
  }
  markQuarantined(input: MarkQuarantinedInput): void {
    this.call("MarkQuarantined", () => this.harness.markQuarantined(input.dump));
  }
  promoteObject(input: PromoteObjectInput): void {
    this.call("PromoteObject", () => this.harness.promoteObject(input.dump));
  }
  rejectDump(input: RejectDumpInput): void {
    this.call("RejectDump", () => this.harness.rejectDump(input.dump));
  }
  revokeToken(input: RevokeTokenInput): void {
    this.call("RevokeToken", () => this.harness.revokeToken(input.token));
  }
  sealUpload(input: SealUploadInput): void {
    this.call("SealUpload", () => this.harness.sealUpload(input.dump));
  }

  observe(): DumpLedgerObservation {
    this.probe.observationCalls += 1;
    this.probe.events.push("observe");
    const observation = this.harness.observe();
    const result = this.mutateObservation?.(observation) ?? observation;
    assertNoPromiseLike(result);
    return result;
  }

  private call(action: string, block: () => void): void {
    this.probe.portCalls += 1;
    this.probe.events.push(`port:${action}`);
    block();
  }
}

type IsExactly<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;
type Assert<Condition extends true> = Condition;

type InitializeReturnsVoid = Assert<
  IsExactly<ReturnType<DumpLedgerMbtPort["initialize"]>, void>
>;
type AcceptDumpReturnsVoid = Assert<
  IsExactly<ReturnType<DumpLedgerMbtPort["acceptDump"]>, void>
>;
type BeginPurgeReturnsVoid = Assert<
  IsExactly<ReturnType<DumpLedgerMbtPort["beginPurge"]>, void>
>;
type BeginUploadReturnsVoid = Assert<
  IsExactly<ReturnType<DumpLedgerMbtPort["beginUpload"]>, void>
>;
type ExpireTokenReturnsVoid = Assert<
  IsExactly<ReturnType<DumpLedgerMbtPort["expireToken"]>, void>
>;
type FailUploadReturnsVoid = Assert<
  IsExactly<ReturnType<DumpLedgerMbtPort["failUpload"]>, void>
>;
type FinishPurgeReturnsVoid = Assert<
  IsExactly<ReturnType<DumpLedgerMbtPort["finishPurge"]>, void>
>;
type IssueTokenReturnsVoid = Assert<
  IsExactly<ReturnType<DumpLedgerMbtPort["issueToken"]>, void>
>;
type MarkQuarantinedReturnsVoid = Assert<
  IsExactly<ReturnType<DumpLedgerMbtPort["markQuarantined"]>, void>
>;
type PromoteObjectReturnsVoid = Assert<
  IsExactly<ReturnType<DumpLedgerMbtPort["promoteObject"]>, void>
>;
type RejectDumpReturnsVoid = Assert<
  IsExactly<ReturnType<DumpLedgerMbtPort["rejectDump"]>, void>
>;
type RevokeTokenReturnsVoid = Assert<
  IsExactly<ReturnType<DumpLedgerMbtPort["revokeToken"]>, void>
>;
type SealUploadReturnsVoid = Assert<
  IsExactly<ReturnType<DumpLedgerMbtPort["sealUpload"]>, void>
>;

type ConcreteVoidAssertions =
  | InitializeReturnsVoid
  | AcceptDumpReturnsVoid
  | BeginPurgeReturnsVoid
  | BeginUploadReturnsVoid
  | ExpireTokenReturnsVoid
  | FailUploadReturnsVoid
  | FinishPurgeReturnsVoid
  | IssueTokenReturnsVoid
  | MarkQuarantinedReturnsVoid
  | PromoteObjectReturnsVoid
  | RejectDumpReturnsVoid
  | RevokeTokenReturnsVoid
  | SealUploadReturnsVoid;

const concreteVoidAssertions: ConcreteVoidAssertions = true;
void concreteVoidAssertions;
