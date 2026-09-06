import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";

import {
  CompiledAdapterRegistry,
  MIRRORECMA_TARGET_PROFILE,
  ModelInterfaceRegistrationError,
  STATE_COMPUTER_CONTRACT_VERSION,
  runClientWithTracesNegotiated,
  semanticDigestFromHex,
  spawnMirror,
  type Transport,
} from "mirrorecma";

import {
  DumpLedgerSemanticDigest,
  type DumpLedgerObservation,
} from "../../src/generated/dump-ledger/DumpLedgerMirror.generated.js";
import { createMbtProbe, type MbtProbe } from "../../src/mbt/harness.js";
import {
  createDumpLedgerMbtSelection,
  dumpLedgerMbtConfig,
} from "../../src/mbt/registry.js";
import { FilesystemVault } from "../../src/vault/filesystem-vault.js";
import { syntheticMinidump } from "../fixtures/minidump/synthetic-minidump.js";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const MIRROR_BIN = process.env.MIRROR_BIN
  ?? "/home/nzsn/Repos/Mirrors/.lake/build/bin/mirror";
const TRACE_ROOT = resolve(REPO_ROOT, "test/fixtures/mbt/traces");

interface Recording {
  readonly transport: Transport;
  readonly received: string[];
  closeCalls(): number;
}

function recordTransport(inner: Transport, probe?: MbtProbe): Recording {
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
            if (!result.done) {
              received.push(result.value);
              const message = JSON.parse(result.value) as {
                proto_step?: string;
                modelInterface?: { status?: string };
              };
              if (
                message.proto_step === "spec_validated"
                && message.modelInterface?.status === "matched"
              ) {
                probe?.events.push("wire:matched");
              }
            }
            return result;
          },
        };
      },
    },
  };
}

class ScriptedTransport implements Transport {
  readonly mode = "stdio" as const;
  readonly sent: string[] = [];
  closes = 0;

  constructor(private readonly lines: readonly string[]) {}

  send(line: string): void {
    this.sent.push(line);
  }

  async close(): Promise<number> {
    this.closes += 1;
    return 0;
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    let index = 0;
    return {
      next: async () => index < this.lines.length
        ? { done: false, value: this.lines[index++]! }
        : { done: true, value: undefined },
    };
  }
}

function steps(lines: readonly string[]): string[] {
  return lines.map((line) => (
    JSON.parse(line) as { proto_step?: string }
  ).proto_step ?? "<missing>");
}

function matchedLine(): string {
  return JSON.stringify({
    proto_step: "spec_validated",
    result: "valid",
    modelInterface: {
      schema: "mirrors.model-interface-negotiation/v1",
      status: "matched",
      descriptorSchema: "mirrors.model-interface-descriptor/v1",
      semanticDigest: `sha256:${DumpLedgerSemanticDigest}`,
    },
  });
}

async function positiveTraces(): Promise<string[]> {
  return (await readdir(TRACE_ROOT))
    .filter((name) => name.endsWith(".itf.json"))
    .sort()
    .map((name) => resolve(TRACE_ROOT, name));
}

const EXPECTED_COVERAGE = {
  AcceptDump: 3,
  BeginPurge: 5,
  BeginUpload: 5,
  CloseCase: 1,
  ExpireToken: 1,
  FailUpload: 1,
  FinishPurge: 5,
  Initialize: 7,
  IssueToken: 8,
  MarkQuarantined: 4,
  PromoteObject: 4,
  RejectDump: 1,
  ResolveCase: 1,
  ResumeInvestigation: 1,
  RevokeToken: 1,
  SealUpload: 4,
  StartInvestigation: 1,
  WaitForCustomer: 1,
} as const;

test("checked-in corpus reaches all_steps_done through negotiated generated binding", async () => {
  const probe = createMbtProbe();
  const recording = recordTransport(spawnMirror(MIRROR_BIN), probe);

  await runClientWithTracesNegotiated(
    recording.transport,
    dumpLedgerMbtConfig(REPO_ROOT),
    await positiveTraces(),
    createDumpLedgerMbtSelection(probe),
  );

  assert.equal(steps(recording.received).at(-1), "all_steps_done");
  assert.equal(probe.factoryCalls, 1);
  assert.equal(probe.bindingDisposeCalls, 1);
  assert.equal(probe.harnessDisposeCalls, 1);
  assert.equal(recording.closeCalls(), 1);
  assert.equal(
    probe.sessionCreates,
    7,
    "each trace must receive a fresh engine and SQLite ledger",
  );
  assert.equal(probe.sessionCloses, 7);
  assert.equal(probe.portCalls, 54);
  assert.equal(
    probe.observationCalls,
    54,
    "each replayed action must be observed exactly once",
  );
  assert.deepEqual(probe.generatedBinding?.coverage(), EXPECTED_COVERAGE);
  probe.generatedBinding?.assertAllActionsCovered();
  assert.equal(
    probe.events[0],
    "wire:matched",
    "factory must not run before an exact matched reply",
  );
  assert.equal(probe.events[1], "factory");
  assert.equal(probe.events.at(-1), "dispose");
});

test("wrong production observation follows ordinary step_mismatch and disposes once", async () => {
  const probe = createMbtProbe();
  const recording = recordTransport(spawnMirror(MIRROR_BIN), probe);
  let changed = false;
  const mutate = (
    observation: DumpLedgerObservation,
  ): DumpLedgerObservation => {
    if (changed || observation.dumpPhase[0] === "absent") return observation;
    changed = true;
    return {
      ...observation,
      dumpPhase: ["absent", observation.dumpPhase[1]!],
    };
  };

  await assert.rejects(
    runClientWithTracesNegotiated(
      recording.transport,
      dumpLedgerMbtConfig(REPO_ROOT),
      [resolve(TRACE_ROOT, "01-accepted-partial-delete.itf.json")],
      createDumpLedgerMbtSelection(probe, { mutateObservation: mutate }),
    ),
    /step mismatch.*dumpPhase/i,
  );

  assert.ok(steps(recording.received).includes("step_mismatch"));
  assert.ok(!steps(recording.received).includes("all_steps_done"));
  assert.equal(probe.factoryCalls, 1);
  assert.ok(probe.engineCalls > 0);
  assert.equal(probe.bindingDisposeCalls, 1);
  assert.equal(probe.harnessDisposeCalls, 1);
  assert.equal(recording.closeCalls(), 1);
});

test("representative accept and reject traces use filesystem vault and production minidump inspection", async () => {
  const cases = [
    {
      trace: "01-accepted-partial-delete.itf.json",
      bytes: syntheticMinidump({ memoryListSizes: [16] }),
    },
    {
      trace: "04-invalid-rejected-delete.itf.json",
      bytes: Buffer.from("not a minidump", "utf8"),
    },
  ];

  for (const fixture of cases) {
    const root = mkdtempSync(resolve(tmpdir(), "dump-ledger-mbt-"));
    try {
      const probe = createMbtProbe();
      const recording = recordTransport(spawnMirror(MIRROR_BIN), probe);
      await runClientWithTracesNegotiated(
        recording.transport,
        dumpLedgerMbtConfig(REPO_ROOT),
        [resolve(TRACE_ROOT, fixture.trace)],
        createDumpLedgerMbtSelection(probe, {
          harness: {
            vaultFactory: () => new FilesystemVault(root),
            uploadBytes: fixture.bytes,
            productionInspection: true,
          },
        }),
      );
      assert.equal(steps(recording.received).at(-1), "all_steps_done");
      assert.equal(probe.factoryCalls, 1);
      assert.equal(probe.bindingDisposeCalls, 1);
      assert.equal(probe.harnessDisposeCalls, 1);
      assert.equal(probe.sessionCreates, 1);
      assert.equal(probe.sessionCloses, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("wrong semantic digest is rejected by Mirrors before factory or SUT calls", async () => {
  const probe = createMbtProbe();
  const recording = recordTransport(spawnMirror(MIRROR_BIN), probe);

  await assert.rejects(
    runClientWithTracesNegotiated(
      recording.transport,
      dumpLedgerMbtConfig(REPO_ROOT),
      [resolve(TRACE_ROOT, "01-accepted-partial-delete.itf.json")],
      createDumpLedgerMbtSelection(probe, {
        semanticDigest: "0".repeat(64),
      }),
    ),
    (error: unknown) => error instanceof ModelInterfaceRegistrationError
      && error.code === "interface_digest_mismatch",
  );

  assert.equal(probe.factoryCalls, 0);
  assert.equal(probe.portCalls, 0);
  assert.equal(probe.engineCalls, 0);
  assert.equal(probe.observationCalls, 0);
  assert.equal(probe.bindingDisposeCalls, 0);
  assert.equal(probe.harnessDisposeCalls, 0);
  assert.ok(!steps(recording.received).includes("initial_state"));
  assert.equal(recording.closeCalls(), 1);
});

test("unregistered exact key and noncanonical digest fail before transport or SUT", async () => {
  const unregisteredProbe = createMbtProbe();
  const transport = new ScriptedTransport([]);
  await assert.rejects(
    runClientWithTracesNegotiated(
      transport,
      dumpLedgerMbtConfig(REPO_ROOT),
      [],
      createDumpLedgerMbtSelection(unregisteredProbe, {
        registry: new CompiledAdapterRegistry([]),
      }),
    ),
    (error: unknown) => (
      error as { code?: string }
    ).code === "adapter_not_registered",
  );
  assert.equal(transport.sent.length, 0);
  assert.equal(transport.closes, 0);
  assert.equal(unregisteredProbe.factoryCalls, 0);
  assert.equal(unregisteredProbe.engineCalls, 0);

  const malformedProbe = createMbtProbe();
  assert.throws(
    () => createDumpLedgerMbtSelection(malformedProbe, {
      semanticDigest: `sha256:${DumpLedgerSemanticDigest}`,
    }),
    /semantic.?digest/i,
  );
  assert.equal(malformedProbe.factoryCalls, 0);
  assert.equal(malformedProbe.engineCalls, 0);
});

test("missing and malformed negotiation replies under require make zero SUT calls", async () => {
  for (const firstLine of [
    JSON.stringify({ proto_step: "spec_validated", result: "valid" }),
    JSON.stringify({
      proto_step: "spec_validated",
      result: "valid",
      modelInterface: {
        schema: "mirrors.model-interface-negotiation/v1",
        status: "matched",
        descriptorSchema: "mirrors.model-interface-descriptor/v1",
        semanticDigest: "sha256:not-a-digest",
      },
    }),
  ]) {
    const probe = createMbtProbe();
    const transport = new ScriptedTransport([firstLine]);
    await assert.rejects(runClientWithTracesNegotiated(
      transport,
      dumpLedgerMbtConfig(REPO_ROOT),
      [],
      createDumpLedgerMbtSelection(probe),
    ));
    assert.equal(probe.factoryCalls, 0);
    assert.equal(probe.portCalls, 0);
    assert.equal(probe.engineCalls, 0);
    assert.equal(probe.observationCalls, 0);
    assert.equal(probe.bindingDisposeCalls, 0);
    assert.equal(probe.harnessDisposeCalls, 0);
    assert.equal(transport.closes, 1);
  }
});

test("unsupported, unavailable, too_large, and structured failures make zero SUT calls", async () => {
  const replies = [
    {
      proto_step: "spec_validated",
      result: "valid",
      modelInterface: {
        schema: "mirrors.model-interface-negotiation/v1",
        status: "unsupported",
      },
    },
    {
      proto_step: "spec_validated",
      result: "valid",
      modelInterface: {
        schema: "mirrors.model-interface-negotiation/v1",
        status: "unavailable",
      },
    },
    {
      proto_step: "spec_validated",
      result: "valid",
      modelInterface: {
        schema: "mirrors.model-interface-negotiation/v1",
        status: "too_large",
        descriptorBytes: 65_536,
      },
    },
    {
      proto_step: "register_error",
      error: "model-interface registration failed",
      modelInterface: {
        schema: "mirrors.model-interface-negotiation/v1",
        status: "mismatch",
        code: "interface_digest_mismatch",
        expectedSemanticDigest: `sha256:${DumpLedgerSemanticDigest}`,
      },
    },
  ];
  for (const reply of replies) {
    const probe = createMbtProbe();
    const transport = new ScriptedTransport([JSON.stringify(reply)]);
    await assert.rejects(runClientWithTracesNegotiated(
      transport,
      dumpLedgerMbtConfig(REPO_ROOT),
      [],
      createDumpLedgerMbtSelection(probe),
    ));
    assert.equal(probe.factoryCalls, 0);
    assert.equal(probe.portCalls, 0);
    assert.equal(probe.engineCalls, 0);
    assert.equal(probe.observationCalls, 0);
    assert.equal(probe.bindingDisposeCalls, 0);
    assert.equal(probe.harnessDisposeCalls, 0);
    assert.equal(transport.closes, 1);
  }
});

test("ambiguous and incompatible exact keys fail before opening transport", async () => {
  const digest = semanticDigestFromHex(DumpLedgerSemanticDigest);
  const cases = [
    new CompiledAdapterRegistry([
      {
        key: {
          semanticDigest: digest,
          adapterId: "dump-ledger-engine/v1",
          targetProfile: MIRRORECMA_TARGET_PROFILE,
          stateComputerContractVersion: STATE_COMPUTER_CONTRACT_VERSION,
        },
        factory: () => {
          throw new Error("must not run");
        },
      },
      {
        key: {
          semanticDigest: digest,
          adapterId: "dump-ledger-engine/v1",
          targetProfile: MIRRORECMA_TARGET_PROFILE,
          stateComputerContractVersion: STATE_COMPUTER_CONTRACT_VERSION,
        },
        factory: () => {
          throw new Error("must not run");
        },
      },
    ]),
    new CompiledAdapterRegistry([{
      key: {
        semanticDigest: digest,
        adapterId: "dump-ledger-engine/v1",
        targetProfile: "wrong-target",
        stateComputerContractVersion: STATE_COMPUTER_CONTRACT_VERSION,
      },
      factory: () => {
        throw new Error("must not run");
      },
    }]),
    new CompiledAdapterRegistry([{
      key: {
        semanticDigest: digest,
        adapterId: "dump-ledger-engine/v1",
        targetProfile: MIRRORECMA_TARGET_PROFILE,
        stateComputerContractVersion: "wrong-contract",
      },
      factory: () => {
        throw new Error("must not run");
      },
    }]),
  ];
  const expectedCodes = [
    "adapter_ambiguous",
    "target_profile_mismatch",
    "state_computer_contract_mismatch",
  ];
  for (let index = 0; index < cases.length; index += 1) {
    const probe = createMbtProbe();
    const transport = new ScriptedTransport([]);
    await assert.rejects(
      runClientWithTracesNegotiated(
        transport,
        dumpLedgerMbtConfig(REPO_ROOT),
        [],
        createDumpLedgerMbtSelection(probe, { registry: cases[index]! }),
      ),
      (error: unknown) => (
        error as { code?: string }
      ).code === expectedCodes[index],
    );
    assert.equal(transport.sent.length, 0);
    assert.equal(transport.closes, 0);
    assert.equal(probe.factoryCalls, 0);
    assert.equal(probe.engineCalls, 0);
  }
});

test("created harness is disposed exactly once on transport, adapter, and observer errors", async () => {
  const scenarios: Array<{
    readonly lines: readonly string[];
    readonly mutateObservation?: (
      observation: DumpLedgerObservation,
    ) => DumpLedgerObservation;
  }> = [
    { lines: [matchedLine()] },
    {
      lines: [
        matchedLine(),
        JSON.stringify({
          proto_step: "initial_state",
          action: "Init",
          state: {},
        }),
        JSON.stringify({
          proto_step: "next_step",
          action: "IssueToken",
          parameters: {
            parameters: {
              token: { "#bigint": "3" },
              dump: { "#bigint": "0" },
              kind: "unclassified",
            },
          },
        }),
      ],
    },
    {
      lines: [
        matchedLine(),
        JSON.stringify({
          proto_step: "initial_state",
          action: "Init",
          state: {},
        }),
      ],
      mutateObservation: (observation) => ({
        ...observation,
        dumpPhase: Promise.resolve([]),
      }) as unknown as DumpLedgerObservation,
    },
  ];

  for (const scenario of scenarios) {
    const probe = createMbtProbe();
    const transport = new ScriptedTransport(scenario.lines);
    await assert.rejects(runClientWithTracesNegotiated(
      transport,
      dumpLedgerMbtConfig(REPO_ROOT),
      [],
      createDumpLedgerMbtSelection(
        probe,
        scenario.mutateObservation === undefined
          ? {}
          : { mutateObservation: scenario.mutateObservation },
      ),
    ));
    assert.equal(probe.factoryCalls, 1);
    assert.equal(probe.bindingDisposeCalls, 1);
    assert.equal(probe.harnessDisposeCalls, 1);
    assert.equal(transport.closes, 1);
  }
});
