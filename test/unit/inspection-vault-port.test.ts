import assert from "node:assert/strict";
import { test } from "node:test";

import { parseDumpId } from "../../src/domain/ids.js";
import type { InspectionPort } from "../../src/engine/inspection-port.js";
import { createVaultMinidumpInspectionPort } from "../../src/inspection/index.js";
import { MemoryVault } from "../../src/vault/memory-vault.js";
import type { VaultReader } from "../../src/vault/vault.js";
import { syntheticMinidump } from "../fixtures/minidump/synthetic-minidump.js";

const dumpId = parseDumpId(`dump_${"0".repeat(26)}`);

class TrackingMemoryVault extends MemoryVault {
  closeCalls = 0;

  override openImmutable(id: typeof dumpId): VaultReader {
    const reader = super.openImmutable(id);
    return {
      size: reader.size,
      read: (position, length) => reader.read(position, length),
      close: () => {
        this.closeCalls += 1;
        reader.close();
      },
    };
  }
}

function promote(vault: MemoryVault, bytes: Uint8Array): void {
  vault.createStaging(dumpId);
  vault.append(dumpId, bytes);
  vault.syncAndClose(dumpId);
  vault.promote(dumpId);
}

test("engine inspection port serializes minidump bigint facts and closes the reader", () => {
  const vault = new TrackingMemoryVault();
  promote(vault, syntheticMinidump({
    flags: 0x2n,
    memory64ListSizes: [7],
    exception: { code: 0xc0000005, address: 0x7ff612341234n },
    modules: [{ name: "renderer.exe", baseOfImage: 0x7ff612340000n }],
  }));
  const port: InspectionPort = createVaultMinidumpInspectionPort(vault);

  const result = port.inspect(dumpId);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.coverage, "full-memory-declared");
  assert.deepEqual(result.facts, {
    minidumpFlags: "2",
    capturedMemoryBytes: "7",
    memoryRangeCount: 1,
    hasMemoryListStream: false,
    hasMemory64ListStream: true,
    exceptionCode: "3221225477",
    exceptionAddress: "140694844084788",
    modules: [{
      name: "renderer.exe",
      baseOfImage: "140694844080128",
      sizeOfImage: 4096,
      timestamp: 0,
    }],
  });
  assert.doesNotThrow(() => JSON.stringify(result.facts));
  assert.equal(vault.closeCalls, 1);
});

test("engine inspection port preserves stable parser errors and closes the reader", () => {
  const vault = new TrackingMemoryVault();
  promote(vault, Buffer.from("not a minidump", "utf8"));
  const port: InspectionPort = createVaultMinidumpInspectionPort(vault);

  assert.deepEqual(port.inspect(dumpId), {
    ok: false,
    error: "truncated: minidump header extends beyond end of file",
  });
  assert.equal(vault.closeCalls, 1);
});

test("engine inspection port converts vault failures to a stable I/O error", () => {
  const vault = new TrackingMemoryVault();
  const port: InspectionPort = createVaultMinidumpInspectionPort(vault);

  assert.deepEqual(port.inspect(dumpId), {
    ok: false,
    error: "io-error: immutable dump could not be inspected",
  });
  assert.equal(vault.closeCalls, 0);
});
