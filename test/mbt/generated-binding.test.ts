import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bindDumpLedger,
  DumpLedgerBindingError,
  type DumpLedgerObservation,
  type DumpLedgerPort,
} from "../../src/generated/dump-ledger/DumpLedgerMirror.generated.js";
import {
  DumpLedgerMbtPort,
  MbtHarness,
  createMbtProbe,
} from "../../src/mbt/harness.js";
import { initialPayload, stepPayload } from "./support/model-values.js";

function assertBindingCode(
  block: () => unknown,
  code: DumpLedgerBindingError["code"],
): void {
  assert.throws(
    block,
    (error: unknown) => error instanceof DumpLedgerBindingError && error.code === code,
  );
}

const VALID_OBSERVATION: DumpLedgerObservation = {
  blobState: ["none", "none"],
  coverage: ["unclassified", "unclassified"],
  digestRecorded: [],
  downloadable: [],
  dumpCase: [0n, 0n],
  dumpPhase: ["absent", "absent"],
  tokenDump: [0n, 0n],
  tokenState: ["unused", "unused"],
  validation: ["not-checked", "not-checked"],
};

function noOpPort(
  observe: () => DumpLedgerObservation = () => VALID_OBSERVATION,
): DumpLedgerPort {
  return {
    initialize(): void {},
    acceptDump(): void {},
    beginPurge(): void {},
    beginUpload(): void {},
    expireToken(): void {},
    failUpload(): void {},
    finishPurge(): void {},
    issueToken(): void {},
    markQuarantined(): void {},
    promoteObject(): void {},
    rejectDump(): void {},
    revokeToken(): void {},
    sealUpload(): void {},
    observe,
  };
}

test("generated binding rejects pre-init transitions and remains poisoned", () => {
  const probe = createMbtProbe();
  const harness = new MbtHarness(probe);
  const binding = bindDumpLedger(
    new DumpLedgerMbtPort(harness, probe),
    { paramVars: "parameters" },
  );

  assertBindingCode(
    () => binding.computer("IssueToken", stepPayload(1n, 0n), {}),
    "transition_before_initialization",
  );
  assertBindingCode(
    () => binding.computer("Init", initialPayload(), {}),
    "binding_poisoned",
  );
  assert.equal(probe.portCalls, 0);
  assert.equal(probe.engineCalls, 0);
  harness.dispose();
});

test("generated binding rejects malformed input before the port and poisons the session", () => {
  const probe = createMbtProbe();
  const harness = new MbtHarness(probe);
  const binding = bindDumpLedger(
    new DumpLedgerMbtPort(harness, probe),
    { paramVars: "parameters" },
  );
  binding.computer("Init", initialPayload(), {});
  const callsBefore = probe.portCalls;

  assertBindingCode(
    () => binding.computer(
      "IssueToken",
      { parameters: { tag: "record", val: {} } },
      {},
    ),
    "input_shape_mismatch",
  );
  assert.equal(probe.portCalls, callsBefore);
  assertBindingCode(
    () => binding.computer("IssueToken", stepPayload(1n, 0n), {}),
    "binding_poisoned",
  );
  harness.dispose();
});

test("generated binding rejects unknown actions and out-of-universe model slots permanently", () => {
  const unknown = bindDumpLedger(noOpPort(), { paramVars: "parameters" });
  unknown.computer("Init", initialPayload(), {});
  assertBindingCode(
    () => unknown.computer("Unknown", stepPayload(0n, 0n), {}),
    "unknown_action",
  );
  assertBindingCode(
    () => unknown.computer("Init", initialPayload(), {}),
    "binding_poisoned",
  );

  const probe = createMbtProbe();
  const harness = new MbtHarness(probe);
  const outOfUniverse = bindDumpLedger(
    new DumpLedgerMbtPort(harness, probe),
    { paramVars: "parameters" },
  );
  outOfUniverse.computer("Init", initialPayload(), {});
  assertBindingCode(
    () => outOfUniverse.computer("IssueToken", stepPayload(3n, 0n), {}),
    "adapter_failure",
  );
  assertBindingCode(
    () => outOfUniverse.computer("IssueToken", stepPayload(1n, 0n), {}),
    "binding_poisoned",
  );
  harness.dispose();
});

test("generated binding poisons failures both before and after adapter mutation", () => {
  let beforeCalls = 0;
  const before = noOpPort();
  before.initialize = (): void => {
    beforeCalls += 1;
    throw new Error("before mutation");
  };
  const beforeBinding = bindDumpLedger(before, { paramVars: "parameters" });
  assertBindingCode(
    () => beforeBinding.computer("Init", initialPayload(), {}),
    "adapter_failure",
  );
  assert.equal(beforeCalls, 1);
  assertBindingCode(
    () => beforeBinding.computer("Init", initialPayload(), {}),
    "binding_poisoned",
  );

  let durableMutations = 0;
  const after = noOpPort();
  after.issueToken = (): void => {
    durableMutations += 1;
    throw new Error("after durable mutation");
  };
  const afterBinding = bindDumpLedger(after, { paramVars: "parameters" });
  afterBinding.computer("Init", initialPayload(), {});
  assertBindingCode(
    () => afterBinding.computer("IssueToken", stepPayload(1n, 0n), {}),
    "adapter_failure",
  );
  assert.equal(durableMutations, 1);
  assertBindingCode(
    () => afterBinding.computer("IssueToken", stepPayload(1n, 0n), {}),
    "binding_poisoned",
  );
  assert.equal(durableMutations, 1);
});

test("generated binding rejects missing, extra, and mistyped observation fields", () => {
  const malformed: unknown[] = [
    { ...VALID_OBSERVATION, tokenState: undefined },
    { ...VALID_OBSERVATION, extra: [] },
    { ...VALID_OBSERVATION, tokenState: [0n, 0n] },
  ];
  for (const observation of malformed) {
    const binding = bindDumpLedger(
      noOpPort(() => observation as DumpLedgerObservation),
      { paramVars: "parameters" },
    );
    assertBindingCode(
      () => binding.computer("Init", initialPayload(), {}),
      "observation_shape_mismatch",
    );
    assertBindingCode(
      () => binding.computer("Init", initialPayload(), {}),
      "binding_poisoned",
    );
  }
});

test("generated binding classifies promise-like observations and poisons the session", () => {
  const thenablePort = {
    initialize(): void {},
    observe: () => Promise.resolve({}),
  } as unknown as DumpLedgerPort;
  const binding = bindDumpLedger(thenablePort, { paramVars: "parameters" });

  assertBindingCode(
    () => binding.computer("Init", initialPayload(), {}),
    "observation_shape_mismatch",
  );
  assertBindingCode(
    () => binding.computer("Init", initialPayload(), {}),
    "binding_poisoned",
  );
});

test("generated binding rejects paramVars mismatch before any port call", () => {
  let calls = 0;
  const port = new Proxy({} as DumpLedgerPort, {
    get() {
      calls += 1;
      return () => {};
    },
  });
  assertBindingCode(
    () => bindDumpLedger(port, { paramVars: "wrong" }),
    "configuration_mismatch",
  );
  assert.equal(calls, 0);
});
