import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  FileRandomAccessSource,
  MinidumpInspector,
} from "../../src/inspection/index.js";
import { syntheticMinidump } from "../fixtures/minidump/synthetic-minidump.js";

test("inspects a minidump through bounded filesystem reads", () => {
  const directory = mkdtempSync(join(tmpdir(), "dump-ledger-inspection-"));
  const path = join(directory, "sample.dmp");
  writeFileSync(path, syntheticMinidump({ flags: 0x2n, memory64ListSizes: [7] }));

  const source = FileRandomAccessSource.open(path);
  try {
    const result = new MinidumpInspector().inspect(source);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.facts.coverage, "full-memory-declared");
    assert.equal(result.facts.capturedMemoryBytes, 7n);
  } finally {
    source.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("filesystem source reads positionally and fails after close", () => {
  const directory = mkdtempSync(join(tmpdir(), "dump-ledger-inspection-"));
  const path = join(directory, "sample.dmp");
  writeFileSync(path, syntheticMinidump());

  const source = FileRandomAccessSource.open(path);
  try {
    assert.equal(source.readAt(0n, 4).toString("ascii"), "MDMP");
    source.close();
    assert.throws(() => source.readAt(0n, 4), /closed/);
  } finally {
    source.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
