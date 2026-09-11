import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

import {
  runClientWithTraces,
  type ApalacheConfig,
} from "mirrorecma";

import {
  createTransferProbe,
  createTransferReplayComputer,
} from "../../src/mbt/transfer-harness.js";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const MIRROR_BIN = process.env.MIRROR_BIN
  ?? "/home/nzsn/Repos/Mirrors/.lake/build/bin/mirror";
const TRACE_ROOT = resolve(REPO_ROOT, "test/fixtures/mbt/transfer-traces");

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

async function positiveTraces(): Promise<string[]> {
  return (await readdir(TRACE_ROOT))
    .filter((name) => name.endsWith(".itf.json"))
    .sort()
    .map((name) => resolve(TRACE_ROOT, name));
}

const EXPECTED_COVERAGE = {
  AcceptDump: 10,
  BeginPurge: 1,
  BeginUpload: 9,
  DeleteBundle: 1,
  ExportFail: 1,
  ExportSeal: 6,
  ExportStart: 7,
  FinishPurge: 1,
  ImportCase: 12,
  ImportCustomer: 12,
  ImportDumpOk: 3,
  ImportDumpReject: 1,
  ImportDumpTombD: 1,
  ImportDumpTombR: 1,
  ImportFinish: 5,
  ImportHardFail: 1,
  ImportStart: 6,
  ImportTokens: 10,
  IssueToken: 11,
  MarkQuarantined: 11,
  PromoteObject: 11,
  RejectDump: 1,
  SealUpload: 8,
  TamperBundle: 1,
  WipeInstance: 6,
} as const;

test("transfer corpus replays to all_steps_done through the handwritten low-level StateComputer", async () => {
  const probe = createTransferProbe();
  const { computer, harness } = createTransferReplayComputer(probe);
  try {
    await runClientWithTraces(
      MIRROR_BIN,
      transferMbtConfig(REPO_ROOT),
      await positiveTraces(),
      computer,
    );
  } finally {
    harness.dispose();
  }

  assert.equal(probe.initializeCalls, 7, "each trace gets a fresh engine, vault, and exports directory");
  assert.equal(probe.actionCalls, 137);
  assert.equal(probe.observeCalls, 144, "one observation per model state across all seven traces");
  assert.equal(probe.sessionCreates, 13, "7 initial instances plus 6 wiped target instances");
  assert.equal(probe.sessionCloses, 13, "every instance generation is closed exactly once");
  assert.equal(probe.disposeCalls, 1);
  assert.deepEqual(
    Object.fromEntries([...probe.actionCounts.entries()].sort()),
    EXPECTED_COVERAGE,
    "the corpus deliberately covers every transfer wire action",
  );
});

test("a tampered observation is detected as a step mismatch", async () => {
  const probe = createTransferProbe();
  const { computer: honest, harness } = createTransferReplayComputer(probe);
  const tampered: typeof honest = async (action, params, prevState, context) => {
    const state = await honest(action, params, prevState, context);
    // Mis-report the grant lifecycle: the mirror must reject the next step.
    return { ...state, tokenState: { tag: "seq", val: [{ tag: "str", val: "unused" }, { tag: "str", val: "unused" }] } };
  };
  try {
    await assert.rejects(
      runClientWithTraces(
        MIRROR_BIN,
        transferMbtConfig(REPO_ROOT),
        [resolve(TRACE_ROOT, "05-export-failed-deleted.itf.json")],
        tampered,
      ),
      /step mismatch/,
    );
  } finally {
    harness.dispose();
  }
});
