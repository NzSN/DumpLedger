import type { DumpId } from "../domain/ids.js";
import type { InspectionOutcome, InspectionPort } from "../engine/inspection-port.js";
import type { Vault, VaultReader } from "../vault/vault.js";
import { MinidumpInspector, type MinidumpFacts } from "./minidump-inspector.js";

const IO_ERROR: InspectionOutcome = {
  ok: false,
  error: "io-error: immutable dump could not be inspected",
};

/** Adapts immutable vault objects to the synchronous engine inspection seam. */
export function createVaultMinidumpInspectionPort(vault: Vault): InspectionPort {
  const inspector = new MinidumpInspector();
  return {
    inspect(dumpId: DumpId): InspectionOutcome {
      let reader: VaultReader | undefined;
      let outcome: InspectionOutcome;
      try {
        const openedReader = vault.openImmutable(dumpId);
        reader = openedReader;
        const result = inspector.inspect({
          size: openedReader.size,
          readAt: (offset, length) => Buffer.from(openedReader.read(offset, length)),
        });
        outcome = result.ok
          ? {
              ok: true,
              coverage: result.facts.coverage,
              facts: serializeFacts(result.facts),
            }
          : {
              ok: false,
              error: `${result.error.code}: ${result.error.message}`,
            };
      } catch {
        outcome = IO_ERROR;
      } finally {
        if (reader !== undefined) {
          try {
            reader.close();
          } catch {
            outcome = IO_ERROR;
          }
        }
      }
      return outcome;
    },
  };
}

function serializeFacts(facts: MinidumpFacts): Readonly<Record<string, unknown>> {
  return {
    minidumpFlags: facts.minidumpFlags.toString(),
    capturedMemoryBytes: facts.capturedMemoryBytes.toString(),
    memoryRangeCount: facts.memoryRangeCount,
    hasMemoryListStream: facts.hasMemoryListStream,
    hasMemory64ListStream: facts.hasMemory64ListStream,
    ...(facts.architecture === undefined ? {} : { architecture: facts.architecture }),
    ...(facts.exceptionCode === undefined
      ? {}
      : { exceptionCode: facts.exceptionCode.toString() }),
    ...(facts.exceptionAddress === undefined
      ? {}
      : { exceptionAddress: facts.exceptionAddress.toString() }),
    ...(facts.modules === undefined
      ? {}
      : {
          modules: facts.modules.map((module) => ({
            ...(module.name === undefined ? {} : { name: module.name }),
            baseOfImage: module.baseOfImage.toString(),
            sizeOfImage: module.sizeOfImage,
            timestamp: module.timestamp,
          })),
        }),
  };
}
