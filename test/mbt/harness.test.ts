import assert from "node:assert/strict";
import { test } from "node:test";

import { bindDumpLedger } from "../../src/generated/dump-ledger/DumpLedgerMirror.generated.js";
import {
  DumpLedgerMbtPort,
  MbtHarness,
  createMbtProbe,
} from "../../src/mbt/harness.js";
import {
  casePayload,
  initialPayload,
  stepPayload,
} from "./support/model-values.js";

test("generated port drives the production engine and observes only its projection", () => {
  const probe = createMbtProbe();
  const harness = new MbtHarness(probe);
  const port = new DumpLedgerMbtPort(harness, probe);
  const binding = bindDumpLedger(port, { paramVars: "parameters" });

  let state = binding.computer("Init", initialPayload(), {});
  state = binding.computer(
    "StartInvestigation",
    casePayload(1n),
    state,
  );
  state = binding.computer("IssueToken", stepPayload(1n, 0n), state);
  state = binding.computer("BeginUpload", stepPayload(1n, 1n), state);
  state = binding.computer("SealUpload", stepPayload(0n, 1n), state);
  state = binding.computer("PromoteObject", stepPayload(0n, 1n), state);
  state = binding.computer("MarkQuarantined", stepPayload(0n, 1n), state);
  state = binding.computer(
    "AcceptDump",
    stepPayload(0n, 1n, "partial"),
    state,
  );

  assert.deepEqual(state.dumpPhase, {
    tag: "seq",
    val: [
      { tag: "str", val: "available" },
      { tag: "str", val: "absent" },
    ],
  });
  assert.deepEqual(state.downloadable, {
    tag: "set",
    val: [{ tag: "int", val: 1n }],
  });
  assert.equal(probe.observationCalls, 8);
  assert.equal(probe.portCalls, 8);
  assert.ok(
    probe.engineCalls > probe.portCalls,
    "initialization must seed real customers and cases",
  );

  harness.dispose();
  harness.dispose();
  assert.equal(probe.harnessDisposeCalls, 1, "harness cleanup is idempotent");
});

test("every concrete generated-port method returns exactly void", () => {
  const probe = createMbtProbe();
  const harness = new MbtHarness(probe);
  const port = new DumpLedgerMbtPort(harness, probe);

  assert.equal(port.initialize(), undefined);
  assert.equal(port.startInvestigation({ case_: 1n }), undefined);
  assert.equal(port.issueToken({ token: 1n }), undefined);
  assert.equal(port.beginUpload({ token: 1n, dump: 1n }), undefined);
  assert.equal(port.failUpload({ dump: 1n }), undefined);
  assert.equal(port.beginPurge({ dump: 1n }), undefined);
  assert.equal(port.finishPurge({ dump: 1n }), undefined);
  harness.dispose();
});
