import assert from "node:assert/strict";
import { test } from "node:test";

import {
  BufferRandomAccessSource,
  MinidumpInspector,
  type RandomAccessSource,
} from "../../src/inspection/index.js";
import {
  directoryOffset,
  syntheticMinidump,
} from "../fixtures/minidump/synthetic-minidump.js";

const inspector = new MinidumpInspector();

function inspect(bytes: Buffer) {
  return inspector.inspect(new BufferRandomAccessSource(bytes));
}

test("classifies selected MemoryList bytes as partial", () => {
  const result = inspect(syntheticMinidump({ memoryListSizes: [3, 5] }));

  assert.deepEqual(result, {
    ok: true,
    facts: {
      coverage: "partial",
      minidumpFlags: 0n,
      capturedMemoryBytes: 8n,
      memoryRangeCount: 2,
      hasMemoryListStream: true,
      hasMemory64ListStream: false,
    },
  });
});

test("classifies MiniDumpWithFullMemory plus Memory64List as full-memory-declared", () => {
  const result = inspect(
    syntheticMinidump({ flags: 0x2n, memory64ListSizes: [4, 7] }),
  );

  assert.deepEqual(result, {
    ok: true,
    facts: {
      coverage: "full-memory-declared",
      minidumpFlags: 0x2n,
      capturedMemoryBytes: 11n,
      memoryRangeCount: 2,
      hasMemoryListStream: false,
      hasMemory64ListStream: true,
    },
  });
});

test("does not mistake MiniDumpWithFullMemoryInfo for full memory", () => {
  const result = inspect(
    syntheticMinidump({ flags: 0x800n, includeMemoryInfoList: true }),
  );

  assert.deepEqual(result, {
    ok: true,
    facts: {
      coverage: "unknown",
      minidumpFlags: 0x800n,
      capturedMemoryBytes: 0n,
      memoryRangeCount: 0,
      hasMemoryListStream: false,
      hasMemory64ListStream: false,
    },
  });
});

test("rejects an impossible MemoryInfoList count", () => {
  const bytes = syntheticMinidump({ includeMemoryInfoList: true });
  const streamRva = bytes.readUInt32LE(directoryOffset(0) + 8);
  bytes.writeBigUInt64LE(65_537n, streamRva + 8);

  const result = inspect(bytes);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "impossible-count");
});

test("reports bounded architecture, exception, and module facts", () => {
  const result = inspect(
    syntheticMinidump({
      architecture: 9,
      exception: { code: 0xc0000005, address: 0x7ff612341234n },
      modules: [
        {
          name: "C:\\app\\renderer.exe",
          baseOfImage: 0x7ff612340000n,
          sizeOfImage: 0x25000,
          timestamp: 0x65aa55cc,
        },
      ],
    }),
  );

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.facts.architecture, "x86_64");
  assert.equal(result.facts.exceptionCode, 0xc0000005n);
  assert.equal(result.facts.exceptionAddress, 0x7ff612341234n);
  assert.deepEqual(result.facts.modules, [
    {
      name: "C:\\app\\renderer.exe",
      baseOfImage: 0x7ff612340000n,
      sizeOfImage: 0x25000,
      timestamp: 0x65aa55cc,
    },
  ]);
});

test("rejects an impossible exception-parameter count", () => {
  const bytes = syntheticMinidump({ exception: { code: 0xc0000005 } });
  const streamRva = bytes.readUInt32LE(directoryOffset(0) + 8);
  bytes.writeUInt32LE(16, streamRva + 32);

  const result = inspect(bytes);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "impossible-count");
});

test("rejects a non-minidump signature", () => {
  const bytes = syntheticMinidump();
  bytes.write("NOPE", 0, "ascii");

  assert.deepEqual(inspect(bytes), {
    ok: false,
    error: {
      code: "invalid-signature",
      message: "minidump signature is not MDMP",
    },
  });
});

test("rejects an unsupported header version", () => {
  const bytes = syntheticMinidump();
  bytes.writeUInt32LE(0xa792, 4);

  const result = inspect(bytes);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "unsupported-version");
});

test("rejects a truncated stream directory", () => {
  const bytes = syntheticMinidump({ memoryListSizes: [] }).subarray(0, 36);

  const result = inspect(bytes);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "truncated");
});

test("rejects untrusted counts before allocating from them", () => {
  const tooManyStreams = syntheticMinidump();
  tooManyStreams.writeUInt32LE(4097, 8);
  const streamResult = inspect(tooManyStreams);
  assert.equal(streamResult.ok, false);
  if (!streamResult.ok) assert.equal(streamResult.error.code, "impossible-count");

  const tooManyRanges = syntheticMinidump({ memoryListSizes: [] });
  tooManyRanges.writeUInt32LE(65537, 44);
  const rangeResult = inspect(tooManyRanges);
  assert.equal(rangeResult.ok, false);
  if (!rangeResult.ok) assert.equal(rangeResult.error.code, "impossible-count");
});

test("rejects arithmetic overflow in Memory64List ranges", () => {
  const bytes = syntheticMinidump({ memory64ListSizes: [0, 0] });
  const streamRva = bytes.readUInt32LE(directoryOffset(0) + 8);
  bytes.writeBigUInt64LE(0xffffffffffffffffn, streamRva + 24);
  bytes.writeBigUInt64LE(1n, streamRva + 40);

  const result = inspect(bytes);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "arithmetic-overflow");
});

test("rejects duplicate critical streams", () => {
  const bytes = syntheticMinidump({ memoryListSizes: [], architecture: 9 });
  bytes.writeUInt32LE(5, directoryOffset(1));

  const result = inspect(bytes);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "duplicate-stream");
});

test("rejects a memory payload that extends beyond the file", () => {
  const bytes = syntheticMinidump({ memoryListSizes: [8] });
  const streamRva = bytes.readUInt32LE(directoryOffset(0) + 8);
  bytes.writeUInt32LE(bytes.length - 4, streamRva + 16);

  const result = inspect(bytes);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "truncated");
});

test("rejects a stream whose declared size cannot contain its descriptors", () => {
  const bytes = syntheticMinidump({ memoryListSizes: [0] });
  bytes.writeUInt32LE(4, directoryOffset(0) + 4);

  const result = inspect(bytes);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "malformed-stream");
});

test("caps module-name lengths before reading string contents", () => {
  const bytes = syntheticMinidump({ modules: [{ name: "x" }] });
  const streamRva = bytes.readUInt32LE(directoryOffset(0) + 8);
  const nameRva = bytes.readUInt32LE(streamRva + 24);
  bytes.writeUInt32LE(65_538, nameRva);

  const result = inspect(bytes);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "resource-limit");
});

test("rejects deterministic truncations without throwing", () => {
  const valid = syntheticMinidump({
    memoryListSizes: [3],
    architecture: 12,
    exception: { code: 0x80000003 },
    modules: [{ name: "sample.dll" }],
  });

  for (const length of [0, 1, 4, 16, 31, 32, 43, valid.length - 1]) {
    const result = inspect(valid.subarray(0, length));
    assert.equal(result.ok, false, `prefix length ${length} must be rejected`);
  }
});

test("uses bounded random-access reads rather than reading captured bytes", () => {
  const bytes = syntheticMinidump({ memoryListSizes: [4096] });
  let largestRead = 0;
  let totalRead = 0;
  const source: RandomAccessSource = {
    size: BigInt(bytes.length),
    readAt(offset, length) {
      largestRead = Math.max(largestRead, length);
      totalRead += length;
      return Buffer.from(bytes.subarray(Number(offset), Number(offset) + length));
    },
  };

  const result = inspector.inspect(source);
  assert.equal(result.ok, true);
  assert.ok(largestRead <= 160);
  assert.ok(totalRead < 1024);
});
