/**
 * Checked application suites (Mirrors application-integration-guide;
 * MirrorECMA application-suites): the DumpLedger and DumpLedgerTransfer
 * corpora replayed through the generated suite bundles via runSuite, with
 * acceptance evidence, cleanup evidence, and a seeded-defect mismatch case.
 * The negotiated/low-level runner tests stay as runner-level anchors; this
 * file is the declarative application gate.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";

import { runSuite, type SuiteConstructionContext, type SuiteImplementation } from "mirrorecma";

import {
  createDumpLedgerSuiteAdapter,
  createTransferSuiteAdapter,
  type DumpLedgerSuiteAdapter,
} from "../../src/mbt/suite-adapters.js";
import {
  BASE_REQUIRED_ACTIONS,
  TRANSFER_REQUIRED_ACTIONS,
  defineDumpLedgerSuite,
  defineTransferSuite,
  type PinnedTrace,
} from "../../src/mbt/suites.js";
import type { DumpLedgerNativeAdapter, DumpLedgerNativeObservation } from "../../src/generated/dump-ledger-suite/DumpLedger.suite.js";
import type { DumpLedgerTransferNativeAdapter } from "../../src/generated/dump-ledger-transfer-suite/DumpLedgerTransfer.suite.js";

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const MIRROR_BIN = process.env.MIRROR_BIN
  ?? "/home/nzsn/Repos/Mirrors/.lake/build/bin/mirror";

async function pinTraces(relativeDirectory: string): Promise<PinnedTrace[]> {
  const directory = resolve(REPO_ROOT, relativeDirectory);
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".itf.json"))
    .sort();
  return Promise.all(names.map(async (name) => {
    const path = resolve(directory, name);
    return { path, sha256: createHash("sha256").update(await readFile(path)).digest("hex") };
  }));
}

function assertPassedSuite(
  result: Awaited<ReturnType<typeof runSuite>>,
  tracesCompleted: number,
  requiredActions: readonly string[],
): void {
  assert.equal(result.outcome, "passed", JSON.stringify(result.failure ?? result.trustedError ?? "no failure detail"));
  assert.equal(result.acceptance.status, "met");
  assert.equal(result.evidence.tracesCompleted, tracesCompleted);
  assert.equal(result.evidence.initializationsMatched, String(tracesCompleted));
  assert.equal(result.cleanup.status, "succeeded");
  assert.equal(result.cleanup.quiescence, "confirmed");
  for (const action of requiredActions) {
    const count = result.evidence.actionCounts[action];
    assert.ok(count !== undefined && BigInt(count) > 0n, `required action ${action} has no matched evidence`);
  }
}

test("the base corpus passes as a checked application suite", async () => {
  const suite = defineDumpLedgerSuite(
    resolve(REPO_ROOT, "specs/DumpLedger.tla"),
    await pinTraces("test/fixtures/mbt/traces"),
  );
  let allocated = 0;
  let disposed = 0;
  const implementation = async (context: SuiteConstructionContext): Promise<SuiteImplementation<DumpLedgerNativeAdapter>> => {
    const adapter = createDumpLedgerSuiteAdapter();
    allocated += 1;
    context.deferCleanup(async () => { disposed += 1; });
    return { port: adapter, dispose: () => adapter.dispose?.() };
  };
  const result = await runSuite(suite, { mirror: MIRROR_BIN, implementation });
  assertPassedSuite(result, 9, BASE_REQUIRED_ACTIONS);
  // 62 port actions include 9 per-trace initializations; transitions are the rest.
  assert.equal(result.evidence.transitionsMatched, String(53));
  assert.equal(allocated, 1, "one adapter serves the corpus; Initialize resets the SUT per trace");
  assert.equal(disposed, 1);
});

test("the transfer corpus passes as a checked application suite", async () => {
  const suite = defineTransferSuite(
    resolve(REPO_ROOT, "specs/DumpLedgerTransfer.tla"),
    await pinTraces("test/fixtures/mbt/transfer-traces"),
  );
  const implementation = async (context: SuiteConstructionContext): Promise<SuiteImplementation<DumpLedgerTransferNativeAdapter>> => {
    const adapter = createTransferSuiteAdapter();
    context.deferCleanup(() => adapter.dispose?.());
    return { port: adapter, dispose: () => adapter.dispose?.() };
  };
  const result = await runSuite(suite, { mirror: MIRROR_BIN, implementation });
  assertPassedSuite(result, 7, TRANSFER_REQUIRED_ACTIONS);
  assert.equal(result.evidence.transitionsMatched, String(138));
});

test("a seeded observation defect is a genuine model mismatch, not a pass", async () => {
  const suite = defineDumpLedgerSuite(
    resolve(REPO_ROOT, "specs/DumpLedger.tla"),
    await pinTraces("test/fixtures/mbt/traces"),
  );
  const implementation = async (context: SuiteConstructionContext): Promise<SuiteImplementation<DumpLedgerNativeAdapter>> => {
    const adapter = createDumpLedgerSuiteAdapter();
    let mutated = false;
    const wrapped: DumpLedgerSuiteAdapter = {
      ...adapter,
      probe: adapter.probe,
      harness: adapter.harness,
      observe: async (observeContext) => {
        const observed: DumpLedgerNativeObservation = await adapter.observe(observeContext);
        if (mutated || observed.DumpPhase[0] === "absent") return observed;
        mutated = true;
        const phases = [...observed.DumpPhase];
        phases[0] = "absent";
        return { ...observed, DumpPhase: phases };
      },
    };
    context.deferCleanup(() => adapter.dispose?.());
    return { port: wrapped, dispose: () => adapter.dispose?.() };
  };
  const result = await runSuite(suite, { mirror: MIRROR_BIN, implementation });
  assert.equal(result.outcome, "mismatch", JSON.stringify(result.failure ?? "no failure detail"));
  assert.ok(result.trustedError !== undefined, "a genuine mismatch carries trusted error evidence");
});
