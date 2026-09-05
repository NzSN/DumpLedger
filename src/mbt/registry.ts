import {
  CompiledAdapterRegistry,
  MIRRORECMA_TARGET_PROFILE,
  STATE_COMPUTER_CONTRACT_VERSION,
  semanticDigestFromHex,
  type ApalacheConfig,
  type CompiledAdapterSelection,
} from "mirrorecma";

import {
  bindDumpLedger,
  DumpLedgerModelInterface,
  DumpLedgerSemanticDigest,
  type DumpLedgerObservation,
} from "../generated/dump-ledger/DumpLedgerMirror.generated.js";
import {
  DumpLedgerMbtPort,
  MbtHarness,
  type MbtHarnessOptions,
  type MbtProbe,
} from "./harness.js";

export const DUMP_LEDGER_ADAPTER_ID = "dump-ledger-engine/v1" as const;

export interface MbtSelectionOptions {
  readonly semanticDigest?: string;
  readonly registry?: CompiledAdapterRegistry;
  readonly mutateObservation?: (
    observation: DumpLedgerObservation,
  ) => DumpLedgerObservation;
  readonly harness?: MbtHarnessOptions;
}

export function dumpLedgerMbtConfig(repoRoot: string): ApalacheConfig {
  return {
    specPath: `${repoRoot}/specs/DumpLedger.tla`,
    initPredicate: "Init",
    nextPredicate: "Next",
    invariant: "SafetyInvariant",
    lengthBound: 8,
    paramVars: "parameters",
  };
}

export function createDumpLedgerMbtSelection(
  probe: MbtProbe,
  options: MbtSelectionOptions = {},
): CompiledAdapterSelection {
  const digestHex = options.semanticDigest ?? DumpLedgerSemanticDigest;
  const semanticDigest = semanticDigestFromHex(digestHex);
  const metadata = options.semanticDigest === undefined
    ? DumpLedgerModelInterface
    : { ...DumpLedgerModelInterface, semanticDigest: digestHex };
  const registry = options.registry ?? new CompiledAdapterRegistry([{
    key: {
      semanticDigest,
      adapterId: DUMP_LEDGER_ADAPTER_ID,
      targetProfile: MIRRORECMA_TARGET_PROFILE,
      stateComputerContractVersion: STATE_COMPUTER_CONTRACT_VERSION,
    },
    factory: (effectiveConfig) => {
      probe.factoryCalls += 1;
      probe.events.push("factory");
      if (effectiveConfig.paramVars !== "parameters") {
        throw new Error("DumpLedger requires paramVars=parameters");
      }
      const harness = new MbtHarness(probe, options.harness);
      const port = new DumpLedgerMbtPort(
        harness,
        probe,
        options.mutateObservation,
      );
      const generated = bindDumpLedger(port, effectiveConfig);
      probe.generatedBinding = generated;
      return {
        semanticDigest,
        computer: generated.computer,
        assertCompatibleConfig: (candidate: ApalacheConfig): void => {
          if (candidate.paramVars !== "parameters") {
            throw new Error("DumpLedger requires paramVars=parameters");
          }
        },
        coverage: generated.coverage,
        dispose: (): void => {
          probe.bindingDisposeCalls += 1;
          probe.events.push("dispose");
          harness.dispose();
        },
      };
    },
  }]);

  return {
    request: "verify",
    metadata,
    adapterId: DUMP_LEDGER_ADAPTER_ID,
    targetProfile: MIRRORECMA_TARGET_PROFILE,
    stateComputerContractVersion: STATE_COMPUTER_CONTRACT_VERSION,
    registry,
    policy: "require",
  };
}
