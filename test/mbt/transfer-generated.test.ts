/**
 * Model-based tests for DumpLedgerTransfer.tla through the Mirrors
 * AUTO-GENERATED async binding (target profile mirrorecma-async-v1),
 * replacing the handwritten low-level StateComputer path in
 * test/mbt/transfer-lowlevel.test.ts.
 *
 * The generated module is produced by the model-interface generate step. It is
 * loaded with a dynamic import() inside each test so this file keeps compiling
 * even before generation; until the module appears, both tests fail with a
 * message that names the generate step to run.
 *
 * Why async: the transfer port drives genuinely asynchronous work (export runs
 * a better-sqlite3 backup), and a fire-and-forget sync binding let WipeInstance
 * close the database mid-backup.
 *
 * Mirrors:
 * - test/mbt/negotiated-runner.test.ts: negotiated replay structure, transport
 *   recording, disposal assertions, fresh-engine-per-trace accounting, and the
 *   mutated-observation -> step_mismatch case.
 * - test/mbt/transfer-lowlevel.test.ts: corpus location (sorted
 *   test/fixtures/mbt/transfer-traces/*.itf.json) and transfer MBT config.
 */

import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import {
  ASYNC_STATE_COMPUTER_CONTRACT_VERSION,
  AsyncCompiledAdapterRegistry,
  MIRRORECMA_ASYNC_TARGET_PROFILE,
  runClientWithTracesNegotiatedWithReport,
  semanticDigestFromHex,
  spawnMirror,
  type ApalacheConfig,
  type AsyncCompiledExecutionSelection,
  type AsyncLocalBinding,
  type AsyncStateComputer,
  type GeneratedModelInterface,
  type ReplayContext,
  type State,
  type Transport,
  type Value,
} from "mirrorecma";

import {
  TransferMbtHarness,
  createTransferProbe,
  type TransferProbe,
} from "../../src/mbt/transfer-harness.js";

/* =============================== ADAPTER SEAM ===============================
 * This block is the ONE place that assumes the API surface of the module the
 * parent generates at:
 *   src/generated/dump-ledger-transfer/DumpLedgerTransferMirror.generated.ts
 *
 * Verify each assumption against the generated module after generation and
 * adjust this block (only this block) to match. Assumed surface, mirroring
 * src/generated/dump-ledger/DumpLedgerMirror.generated.ts and
 * src/mbt/registry.ts:
 *
 *  A1. Exports: bindDumpLedgerTransferAsync,
 *      bindDumpLedgerTransferAsyncPublicPort (unused here),
 *      DumpLedgerTransferModelInterface, DumpLedgerTransferSemanticDigest
 *      (bare lowercase sha256 hex), DumpLedgerTransferAsyncTargetProfile,
 *      DumpLedgerTransferAsyncStateComputerContractVersion, and a native
 *      DumpLedgerTransferObservation type.
 *  A2. bindDumpLedgerTransferAsync(port, config) returns
 *      { computer: AsyncStateComputer; assertCompatibleConfig(config);
 *        coverage(): Record<actionId, number>;
 *        assertAllActionsCovered(): void }
 *      and rejects config.paramVars !== "parameters" from
 *      assertCompatibleConfig (like the base binding).
 *  A3. coverage() is keyed by contract action ids: transition ids are the
 *      wire labels (ExportStart, ImportDumpOk, ...) and the initializer id is
 *      "Initialize" for wire label "Init" (the base contract's convention).
 *  A4. Port methods are async: `(input, context: ReplayContext) =>
 *      Promise<void>`, inputless actions are `(context) => Promise<void>`,
 *      and observe(context) returns Promise<DumpLedgerTransferObservation>.
 *      Names are lowerFirst(action id): initialize, acceptDump, beginPurge,
 *      beginUpload, deleteBundle, exportFail, exportSeal, exportStart,
 *      finishPurge, importCase, importCustomer, importDumpOk, importDumpReject,
 *      importDumpTombD, importDumpTombR, importFinish, importHardFail,
 *      importStart, importTokens, issueToken, markQuarantined, promoteObject,
 *      rejectDump, sealUpload, tamperBundle, wipeInstance.
 *  A5. Port inputs are the action's declared contract inputs, decoded by the
 *      binding from `parameters` (`case` spelled `case_`); the initializer
 *      receives fingerprintMatches projected from the trace's initial state
 *      (descriptor root "initialState") because TransferInit pins that
 *      variable. The guard below stays: if the contract ever drops that input,
 *      the test must fail loudly at the port seam rather than misreport state.
 *  A6. observe() returns the native observation whose fields are the model's
 *      non-wire variables, lowerFirst: caseStatus, tokenState, tokenUploads,
 *      dumpToken, tokFirstDump, dumpPhase, dumpCase, blobState,
 *      digestRecorded, validation, coverage, downloadable, wiped,
 *      fingerprintMatches, bundle { bad, cstat, dcase, dcov, deleted, gdump,
 *      gstate, guploads, promised, rejected, status }, custDone, caseDone,
 *      done, tokDone.
 *  A7. TransferMbtHarness.observe() still returns a wire State (the
 *      handwritten low-level contract), so this seam decodes it to the native
 *      observation with the exact inverse of the generated encodeNative; the
 *      async harness actions (exportStart/exportSeal/exportFail) are awaited
 *      inside the port. If the harness grows a native observe() before this
 *      lands, drop decodeWireState and return harness.observe() directly.
 *  A8. Local adapterId "dump-ledger-transfer-engine/v1" is only a local
 *      registry key; rename freely as long as the selection stays consistent.
 *  A9. Async execution goes through runClientWithTracesNegotiatedWithReport
 *      with { execution: "async", mode: "compiled", request: "verify",
 *      policy: "require" } and an AsyncCompiledAdapterRegistry (the canonical
 *      async entry point; runClientWithTracesNegotiated's type only accepts
 *      callback selections). The port does NOT thread context.signal /
 *      context.deadline into the synchronous harness API; the runner enforces
 *      the per-step deadline around the awaited promise.
 * ========================================================================== */

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const MIRROR_BIN = process.env.MIRROR_BIN
  ?? "/home/nzsn/Repos/Mirrors/.lake/build/bin/mirror";
const TRACE_ROOT = resolve(REPO_ROOT, "test/fixtures/mbt/transfer-traces");
const TRANSFER_ADAPTER_ID = "dump-ledger-transfer-engine/v1";
const GENERATED_SOURCE_PATH =
  "src/generated/dump-ledger-transfer/DumpLedgerTransferMirror.generated.ts";
const GENERATED_MODULE_PATH = resolve(
  import.meta.dirname,
  "../../src/generated/dump-ledger-transfer/DumpLedgerTransferMirror.generated.js",
);

interface BundleObservation {
  readonly status: string;
  readonly promised: readonly bigint[];
  readonly rejected: readonly bigint[];
  readonly deleted: readonly bigint[];
  readonly bad: bigint;
  readonly cstat: readonly string[];
  readonly gstate: readonly string[];
  readonly gdump: readonly bigint[];
  readonly guploads: readonly bigint[];
  readonly dcase: readonly bigint[];
  readonly dcov: readonly string[];
}

/** A6: native observation the generated binding encodes. */
interface DumpLedgerTransferObservation {
  readonly caseStatus: readonly string[];
  readonly tokenState: readonly string[];
  readonly tokenUploads: readonly bigint[];
  readonly dumpToken: readonly bigint[];
  readonly tokFirstDump: readonly bigint[];
  readonly dumpPhase: readonly string[];
  readonly dumpCase: readonly bigint[];
  readonly blobState: readonly string[];
  readonly digestRecorded: readonly bigint[];
  readonly validation: readonly string[];
  readonly coverage: readonly string[];
  readonly downloadable: readonly bigint[];
  readonly wiped: boolean;
  readonly fingerprintMatches: boolean;
  readonly bundle: BundleObservation;
  readonly custDone: readonly bigint[];
  readonly caseDone: readonly bigint[];
  readonly done: readonly bigint[];
  readonly tokDone: readonly bigint[];
}

type MutateObservation = (
  observation: DumpLedgerTransferObservation,
) => DumpLedgerTransferObservation;

interface InitializeInput {
  readonly fingerprintMatches: boolean;
}

/** A4/A5: the assumed async port surface passed to bindDumpLedgerTransferAsync. */
interface TransferGeneratedPort {
  initialize(input: InitializeInput, context: ReplayContext): Promise<void>;
  acceptDump(
    input: { readonly dump: bigint; readonly kind: string },
    context: ReplayContext,
  ): Promise<void>;
  beginPurge(input: { readonly dump: bigint }, context: ReplayContext): Promise<void>;
  beginUpload(
    input: { readonly dump: bigint; readonly token: bigint },
    context: ReplayContext,
  ): Promise<void>;
  deleteBundle(context: ReplayContext): Promise<void>;
  exportFail(context: ReplayContext): Promise<void>;
  exportSeal(context: ReplayContext): Promise<void>;
  exportStart(context: ReplayContext): Promise<void>;
  finishPurge(input: { readonly dump: bigint }, context: ReplayContext): Promise<void>;
  importCase(input: { readonly case_: bigint }, context: ReplayContext): Promise<void>;
  importCustomer(input: { readonly case_: bigint }, context: ReplayContext): Promise<void>;
  importDumpOk(
    input: { readonly case_: bigint; readonly dump: bigint },
    context: ReplayContext,
  ): Promise<void>;
  importDumpReject(
    input: { readonly case_: bigint; readonly dump: bigint },
    context: ReplayContext,
  ): Promise<void>;
  importDumpTombD(
    input: { readonly case_: bigint; readonly dump: bigint },
    context: ReplayContext,
  ): Promise<void>;
  importDumpTombR(
    input: { readonly case_: bigint; readonly dump: bigint },
    context: ReplayContext,
  ): Promise<void>;
  importFinish(context: ReplayContext): Promise<void>;
  importHardFail(context: ReplayContext): Promise<void>;
  importStart(context: ReplayContext): Promise<void>;
  importTokens(input: { readonly token: bigint }, context: ReplayContext): Promise<void>;
  issueToken(input: { readonly token: bigint }, context: ReplayContext): Promise<void>;
  markQuarantined(input: { readonly dump: bigint }, context: ReplayContext): Promise<void>;
  promoteObject(input: { readonly dump: bigint }, context: ReplayContext): Promise<void>;
  rejectDump(input: { readonly dump: bigint }, context: ReplayContext): Promise<void>;
  sealUpload(input: { readonly dump: bigint }, context: ReplayContext): Promise<void>;
  tamperBundle(input: { readonly dump: bigint }, context: ReplayContext): Promise<void>;
  wipeInstance(context: ReplayContext): Promise<void>;
  observe(context: ReplayContext): Promise<DumpLedgerTransferObservation>;
}

/** A1/A2: the assumed binding returned by the generated async factory. */
interface GeneratedTransferBinding {
  readonly computer: AsyncStateComputer;
  assertCompatibleConfig(config: Pick<ApalacheConfig, "paramVars">): void;
  coverage(): Readonly<Record<string, number>>;
  assertAllActionsCovered(): void;
}

/** A1/A2: the assumed module surface. */
interface GeneratedTransferModule {
  bindDumpLedgerTransferAsync(
    port: TransferGeneratedPort,
    config: Pick<ApalacheConfig, "paramVars">,
  ): GeneratedTransferBinding;
  readonly DumpLedgerTransferModelInterface: GeneratedModelInterface;
  readonly DumpLedgerTransferSemanticDigest: string;
}

async function loadGeneratedTransferModule(): Promise<GeneratedTransferModule> {
  let loaded: unknown;
  try {
    loaded = await import(pathToFileURL(GENERATED_MODULE_PATH).href);
  } catch (error) {
    if (
      error instanceof Error
      && (error as NodeJS.ErrnoException).code === "ERR_MODULE_NOT_FOUND"
    ) {
      throw new Error(
        `DumpLedgerTransfer generated binding module is absent (${GENERATED_SOURCE_PATH}). ` +
          "run the model-interface generate step first: the transfer analogue of " +
          "tools/check-model-interface.sh, i.e. model_interface_gen check " +
          "--spec specs/DumpLedgerTransfer.tla --out src/generated/dump-ledger-transfer " +
          "--target mirrorecma-async-v1 --param-var parameters, then build.",
        { cause: error },
      );
    }
    throw error;
  }
  return loaded as GeneratedTransferModule;
}

/* ------------------------------- test plumbing ---------------------------- */

interface Recording {
  readonly transport: Transport;
  readonly received: string[];
  closeCalls(): number;
}

function recordTransport(inner: Transport): Recording {
  const received: string[] = [];
  let closes = 0;
  return {
    received,
    closeCalls: () => closes,
    transport: {
      ...(inner.mode === undefined ? {} : { mode: inner.mode }),
      send: (line) => inner.send(line),
      close: async () => {
        closes += 1;
        return inner.close();
      },
      [Symbol.asyncIterator](): AsyncIterator<string> {
        const iterator = inner[Symbol.asyncIterator]();
        return {
          next: async () => {
            const result = await iterator.next();
            if (!result.done) received.push(result.value);
            return result;
          },
        };
      },
    },
  };
}

function steps(lines: readonly string[]): string[] {
  return lines.map((line) => (
    JSON.parse(line) as { proto_step?: string }
  ).proto_step ?? "<missing>");
}

function transferMbtConfig(repoRoot: string): ApalacheConfig {
  return {
    specPath: `${repoRoot}/specs/DumpLedgerTransfer.tla`,
    initPredicate: "TransferInit",
    nextPredicate: "TransferNext",
    invariant: "TransferSafetyFull",
    lengthBound: 28,
    paramVars: "parameters",
  };
}

async function transferTraces(): Promise<string[]> {
  return (await readdir(TRACE_ROOT))
    .filter((name) => name.endsWith(".itf.json"))
    .sort()
    .map((name) => resolve(TRACE_ROOT, name));
}

interface TransferNegotiatedProbe {
  readonly transfer: TransferProbe;
  generatedBinding: GeneratedTransferBinding | undefined;
  factoryCalls: number;
  bindingDisposeCalls: number;
}

function createTransferNegotiatedProbe(): TransferNegotiatedProbe {
  return {
    transfer: createTransferProbe(),
    generatedBinding: undefined,
    factoryCalls: 0,
    bindingDisposeCalls: 0,
  };
}

/* --------------------------- port adaptation (A4-A7) ---------------------- */

function decodeWireValue(value: Value): unknown {
  switch (value.tag) {
    case "int": return value.val;
    case "bool": return value.val;
    case "str": return value.val;
    case "null": return null;
    case "set": return value.val.map(decodeWireValue);
    case "seq": return value.val.map(decodeWireValue);
    case "tuple": return value.val.map(decodeWireValue);
    case "map": return value.val.map(([key, item]) => [decodeWireValue(key), decodeWireValue(item)]);
    case "record":
      return Object.fromEntries(
        Object.entries(value.val).map(([key, item]) => [key, decodeWireValue(item)]),
      );
    case "variant": return { tag: value.variantTag, value: decodeWireValue(value.value) };
    case "unserializable":
      throw new Error(`wire observation carried an unserializable value: ${value.val}`);
    default:
      throw new Error(
        `observation value is not a mirrorecma wire Value (tag=${String(
          (value as { tag?: unknown }).tag,
        )}); if TransferMbtHarness now returns native observations, update the adapter seam`,
      );
  }
}

function decodeWireState(state: State): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(state).map(([key, value]) => [key, decodeWireValue(value)]),
  );
}

/**
 * A4-A7 seam: drives TransferMbtHarness for the generated async binding while
 * keeping the probe accounting identical to the handwritten low-level computer
 * (transfer-lowlevel.test.ts), so the same corpus invariants can be asserted.
 * Counters increment before the adapter work completes, matching the low-level
 * dispatch order.
 */
function createGeneratedTransferPort(
  harness: TransferMbtHarness,
  probe: TransferProbe,
  mutateObservation: MutateObservation | undefined,
): TransferGeneratedPort {
  const action = async (
    label: string,
    block: () => void | Promise<void>,
  ): Promise<void> => {
    probe.actionCalls += 1;
    probe.actionCounts.set(label, (probe.actionCounts.get(label) ?? 0) + 1);
    await block();
  };

  const initialize = async (
    input: InitializeInput | undefined,
    _context: ReplayContext,
  ): Promise<void> => {
    if (input === undefined || typeof input.fingerprintMatches !== "boolean") {
      throw new Error(
        "the generated binding called the transfer initializer without a fingerprintMatches " +
          "input; the sealed DumpLedgerTransfer contract must project it from the initial " +
          "state (descriptor root initialState) - update the adapter seam in this file",
      );
    }
    harness.initialize(input.fingerprintMatches);
  };

  return {
    initialize,
    acceptDump: (input, _context) => action(
      "AcceptDump",
      () => harness.acceptDump(input.dump, input.kind),
    ),
    beginPurge: (input, _context) => action("BeginPurge", () => harness.beginPurge(input.dump)),
    beginUpload: (input, _context) => action(
      "BeginUpload",
      () => harness.beginUpload(input.token, input.dump),
    ),
    deleteBundle: (_context) => action("DeleteBundle", () => harness.deleteBundle()),
    exportFail: (_context) => action("ExportFail", () => harness.exportFail()),
    exportSeal: (_context) => action("ExportSeal", () => harness.exportSeal()),
    exportStart: (_context) => action("ExportStart", () => harness.exportStart()),
    finishPurge: (input, _context) => action("FinishPurge", () => harness.finishPurge(input.dump)),
    importCase: (input, _context) => action("ImportCase", () => harness.importCase(input.case_)),
    importCustomer: (input, _context) => action(
      "ImportCustomer",
      () => harness.importCustomer(input.case_),
    ),
    importDumpOk: (input, _context) => action(
      "ImportDumpOk",
      () => harness.importDump(input.dump, input.case_),
    ),
    importDumpReject: (input, _context) => action(
      "ImportDumpReject",
      () => harness.importDump(input.dump, input.case_),
    ),
    importDumpTombD: (input, _context) => action(
      "ImportDumpTombD",
      () => harness.importDump(input.dump, input.case_),
    ),
    importDumpTombR: (input, _context) => action(
      "ImportDumpTombR",
      () => harness.importDump(input.dump, input.case_),
    ),
    importFinish: (_context) => action("ImportFinish", () => harness.importFinish()),
    importHardFail: (_context) => action("ImportHardFail", () => harness.importHardFail()),
    importStart: (_context) => action("ImportStart", () => harness.importStart()),
    importTokens: (input, _context) => action("ImportTokens", () => harness.importTokens(input.token)),
    issueToken: (input, _context) => action("IssueToken", () => harness.issueToken(input.token)),
    markQuarantined: (input, _context) => action(
      "MarkQuarantined",
      () => harness.markQuarantined(input.dump),
    ),
    promoteObject: (input, _context) => action("PromoteObject", () => harness.promoteObject(input.dump)),
    rejectDump: (input, _context) => action("RejectDump", () => harness.rejectDump(input.dump)),
    sealUpload: (input, _context) => action("SealUpload", () => harness.sealUpload(input.dump)),
    tamperBundle: (input, _context) => action("TamperBundle", () => harness.tamperBundle(input.dump)),
    wipeInstance: (_context) => action("WipeInstance", () => harness.wipeInstance()),
    observe: async (_context) => {
      const decoded = decodeWireState(harness.observe()) as unknown as DumpLedgerTransferObservation;
      return mutateObservation === undefined ? decoded : mutateObservation(decoded);
    },
  };
}

/* ------------------------ negotiated selection (A1/A2) -------------------- */

interface TransferSelectionOptions {
  readonly mutateObservation?: MutateObservation;
}

function createTransferMbtSelection(
  probe: TransferNegotiatedProbe,
  generated: GeneratedTransferModule,
  options: TransferSelectionOptions = {},
): AsyncCompiledExecutionSelection {
  const semanticDigest = semanticDigestFromHex(generated.DumpLedgerTransferSemanticDigest);
  const key = {
    semanticDigest,
    adapterId: TRANSFER_ADAPTER_ID,
    targetProfile: MIRRORECMA_ASYNC_TARGET_PROFILE,
    stateComputerContractVersion: ASYNC_STATE_COMPUTER_CONTRACT_VERSION,
  };
  const registry = new AsyncCompiledAdapterRegistry([{
    key,
    factory: (effectiveConfig: ApalacheConfig): AsyncLocalBinding => {
      probe.factoryCalls += 1;
      const harness = new TransferMbtHarness(probe.transfer);
      const port = createGeneratedTransferPort(
        harness,
        probe.transfer,
        options.mutateObservation,
      );
      const binding = generated.bindDumpLedgerTransferAsync(port, effectiveConfig);
      probe.generatedBinding = binding;
      return {
        semanticDigest,
        computer: binding.computer,
        assertCompatibleConfig: binding.assertCompatibleConfig,
        coverage: binding.coverage,
        dispose: (): void => {
          probe.bindingDisposeCalls += 1;
          harness.dispose();
        },
      };
    },
  }]);

  return {
    execution: "async",
    mode: "compiled",
    request: "verify",
    policy: "require",
    metadata: generated.DumpLedgerTransferModelInterface,
    ...key,
    registry,
  };
}

/* ---------------------------------- tests --------------------------------- */

test("transfer corpus reaches all_steps_done through the negotiated generated async binding", async () => {
  const generated = await loadGeneratedTransferModule();
  const traces = await transferTraces();
  assert.ok(traces.length > 0, "the transfer trace corpus must not be empty");

  const probe = createTransferNegotiatedProbe();
  const recording = recordTransport(spawnMirror(MIRROR_BIN));

  const report = await runClientWithTracesNegotiatedWithReport(
    recording.transport,
    transferMbtConfig(REPO_ROOT),
    traces,
    createTransferMbtSelection(probe, generated),
  );

  assert.equal(report.status, "completed");
  assert.equal(report.acceptedTraces, traces.length);

  const { transfer } = probe;
  assert.equal(
    steps(recording.received).at(-1),
    "all_steps_done",
    "every corpus trace must replay to the final protocol step",
  );
  assert.equal(probe.factoryCalls, 1);
  assert.equal(probe.bindingDisposeCalls, 1, "the binding must be disposed exactly once");
  assert.equal(transfer.disposeCalls, 1, "the harness must be disposed exactly once");
  assert.equal(recording.closeCalls(), 1);

  assert.equal(
    transfer.initializeCalls,
    traces.length,
    "each trace must initialize a fresh engine and SQLite ledger",
  );
  /* Corpus contract (verified against the handwritten path): 7 traces,
   * 138 wire actions, 145 observations (one per model state), 13 session
   * generations (7 initial + 6 wiped targets). */
  assert.equal(transfer.actionCalls, 138, "the corpus dispatches 138 wire actions");
  assert.equal(transfer.observeCalls, 145, "one observation per model state across all seven traces");
  assert.equal(transfer.sessionCreates, 13, "7 initial generations plus 6 wiped target generations");
  /* TransferMbtHarness.wipeInstance() closes the current instance generation
   * and opens a fresh target one, so creations are trace count + wipes. */
  const wipeCount = transfer.actionCounts.get("WipeInstance") ?? 0;
  assert.equal(
    transfer.sessionCreates,
    traces.length + wipeCount,
    "each trace starts one fresh instance, and each WipeInstance starts another",
  );
  assert.equal(
    transfer.sessionCloses,
    transfer.sessionCreates,
    "every instance generation is closed exactly once",
  );
  assert.equal(
    transfer.observeCalls,
    transfer.actionCalls + transfer.initializeCalls,
    "the initial state and every action must be observed exactly once",
  );

  const binding = probe.generatedBinding;
  if (binding === undefined) {
    throw new Error("the adapter factory must expose the generated binding on the probe");
  }
  binding.assertAllActionsCovered();
  const coverage: Readonly<Record<string, number>> = binding.coverage();
  const dispatched: Record<string, number> = {
    Initialize: transfer.initializeCalls,
    ...Object.fromEntries(transfer.actionCounts),
  };
  assert.deepEqual(
    { ...coverage },
    dispatched,
    "binding coverage must match the wire actions dispatched through the port",
  );
  assert.equal(
    report.acceptedSteps,
    transfer.actionCalls,
    "the runner must accept one step per dispatched wire action",
  );
  assert.deepEqual(
    { ...report.actionCoverage },
    dispatched,
    "runner-side coverage must match the wire actions dispatched through the port",
  );
});

test("mutated production observation is rejected as step_mismatch and never completes", async () => {
  const generated = await loadGeneratedTransferModule();
  const probe = createTransferNegotiatedProbe();
  const recording = recordTransport(spawnMirror(MIRROR_BIN));

  let mutated = false;
  const mutate = (
    observation: DumpLedgerTransferObservation,
  ): DumpLedgerTransferObservation => {
    if (mutated || observation.dumpPhase[0] === "absent") return observation;
    mutated = true;
    return { ...observation, dumpPhase: ["absent", observation.dumpPhase[1]!] };
  };

  await assert.rejects(
    runClientWithTracesNegotiatedWithReport(
      recording.transport,
      transferMbtConfig(REPO_ROOT),
      [resolve(TRACE_ROOT, "01-round-trip-available.itf.json")],
      createTransferMbtSelection(probe, generated, { mutateObservation: mutate }),
    ),
    /step mismatch/i,
  );

  assert.equal(mutated, true, "the mutation must actually fire mid-trace");
  const received = steps(recording.received);
  assert.ok(received.includes("initial_state"), "the replay must begin from the trace initial state");
  assert.ok(received.includes("step_mismatch"), "the mirror must report step_mismatch");
  assert.ok(
    !received.includes("all_steps_done"),
    "a mismatched replay must never reach all_steps_done",
  );
  assert.equal(probe.transfer.initializeCalls, 1);
  assert.ok(probe.transfer.actionCalls > 0, "the SUT must have been driven before the mismatch");
  assert.equal(probe.factoryCalls, 1);
  assert.equal(probe.bindingDisposeCalls, 1, "the binding must be disposed exactly once");
  assert.equal(probe.transfer.disposeCalls, 1, "the harness must be disposed exactly once");
  assert.equal(recording.closeCalls(), 1);
});
