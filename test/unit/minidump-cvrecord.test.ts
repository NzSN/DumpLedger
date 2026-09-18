import assert from "node:assert/strict";
import { test } from "node:test";

import { parseDumpId } from "../../src/domain/ids.js";
import {
  BufferRandomAccessSource,
  createVaultMinidumpInspectionPort,
  MinidumpInspector,
  type ModuleFact,
} from "../../src/inspection/index.js";
import {
  decodeStorePath,
  encodeStorePath,
  parseRsdsCodeViewRecord,
} from "../../src/symbols/identity.js";
import { MemoryVault } from "../../src/vault/memory-vault.js";
import {
  directoryOffset,
  rsdsRecord,
  syntheticMinidump,
} from "../fixtures/minidump/synthetic-minidump.js";

/**
 * Dump <-> symbol linkage coverage (docs/symbols-design.md, milestone 2):
 * raw CodeView RSDS parsing and the best-effort per-module CvRecord extraction
 * in the minidump inspector, including the serialized facts shape that other
 * surfaces consume. Fixtures are built in code -- no checked-in binaries.
 */

const inspector = new MinidumpInspector();

function inspect(bytes: Buffer) {
  return inspector.inspect(new BufferRandomAccessSource(bytes));
}

function inspectModulesOf(bytes: Buffer): readonly ModuleFact[] {
  const result = inspect(bytes);
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("inspection failed unexpectedly");
  return result.facts.modules ?? [];
}

/**
 * GUID 01234567-89AB-CDEF-0123-456789ABCDEF written the way a CodeView record
 * stores it: Data1/Data2/Data3 little-endian, Data4 in file order.
 */
function canonicalGuidBytes(): Buffer {
  return guidBytes(0x01234567, 0x89ab, 0xcdef, [0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]);
}

function guidBytes(data1: number, data2: number, data3: number, data4: readonly number[]): Buffer {
  const bytes = Buffer.alloc(16);
  bytes.writeUInt32LE(data1 >>> 0, 0);
  bytes.writeUInt16LE(data2, 4);
  bytes.writeUInt16LE(data3, 6);
  data4.forEach((value, index) => {
    bytes[8 + index] = value;
  });
  return bytes;
}

// --- direct RSDS record parsing ---------------------------------------------

test("parseRsdsCodeViewRecord reads a canonical record and round-trips the store path", () => {
  const identity = parseRsdsCodeViewRecord(
    rsdsRecord("C:\\build\\out\\renderer.pdb", canonicalGuidBytes(), 1),
  );

  assert.deepEqual(identity, {
    debugFile: "renderer.pdb",
    debugId: "0123456789ABCDEF0123456789ABCDEF1",
  });
  if (identity === undefined) return;
  assert.deepEqual(decodeStorePath(encodeStorePath(identity.debugFile, identity.debugId)), {
    debugFile: "renderer.pdb",
    debugId: "0123456789ABCDEF0123456789ABCDEF1",
    file: "renderer.pdb",
  });
});

test("parseRsdsCodeViewRecord hand-computes the SymSrv byte order", () => {
  // Stored GUID bytes: EF BE AD DE | FE CA | 34 12 | 00 11 22 33 44 55 66 77.
  // SymSrv format reverses Data1-Data3 and keeps Data4 literal, so the hex is
  // DEADBEEF CAFE 1234 0011223344556677 followed by the age AB.
  const identity = parseRsdsCodeViewRecord(
    rsdsRecord("renderer.pdb", guidBytes(0xdeadbeef, 0xcafe, 0x1234, [0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]), 0xab),
  );

  assert.deepEqual(identity, {
    debugFile: "renderer.pdb",
    debugId: "DEADBEEFCAFE12340011223344556677AB",
  });
});

test("parseRsdsCodeViewRecord takes the basename from either separator style", () => {
  for (const pdbPath of ["C:\\agents\\work\\renderer.pdb", "d:/src/out/renderer.pdb", "renderer.pdb"]) {
    const identity = parseRsdsCodeViewRecord(rsdsRecord(pdbPath, canonicalGuidBytes(), 1));
    assert.equal(identity?.debugFile, "renderer.pdb", `path ${pdbPath}`);
  }
});

test("parseRsdsCodeViewRecord tolerates bytes after the NUL terminator", () => {
  const padded = Buffer.concat([
    Buffer.from(rsdsRecord("C:\\out\\renderer.pdb", canonicalGuidBytes(), 0x2a)),
    Buffer.alloc(16, 0xaa),
  ]);

  assert.deepEqual(parseRsdsCodeViewRecord(padded), {
    debugFile: "renderer.pdb",
    debugId: "0123456789ABCDEF0123456789ABCDEF2A",
  });
});

test("parseRsdsCodeViewRecord reads a record at a byte offset inside a larger buffer", () => {
  const record = Buffer.from(rsdsRecord("C:\\out\\renderer.pdb", canonicalGuidBytes(), 1));
  const container = Buffer.concat([Buffer.alloc(7, 0xcc), record, Buffer.alloc(3, 0xdd)]);

  assert.deepEqual(parseRsdsCodeViewRecord(container.subarray(7, 7 + record.length)), {
    debugFile: "renderer.pdb",
    debugId: "0123456789ABCDEF0123456789ABCDEF1",
  });
});

test("parseRsdsCodeViewRecord returns undefined for non-RSDS and malformed records", () => {
  const valid = Buffer.from(rsdsRecord("C:\\out\\renderer.pdb", canonicalGuidBytes(), 1));

  // NB10 ("new format") CodeView records carry no RSDS GUID/age.
  assert.equal(
    parseRsdsCodeViewRecord(Buffer.concat([Buffer.from("NB10", "latin1"), Buffer.alloc(64, 0x5a)])),
    undefined,
  );
  assert.equal(parseRsdsCodeViewRecord(new Uint8Array(0)), undefined);
  assert.equal(parseRsdsCodeViewRecord(Buffer.from("RSDS", "latin1")), undefined);
  // Path missing its NUL terminator (truncated record).
  assert.equal(parseRsdsCodeViewRecord(valid.subarray(0, valid.length - 1)), undefined);
  // Empty path: the terminator directly follows the header.
  assert.equal(parseRsdsCodeViewRecord(rsdsRecord("", canonicalGuidBytes(), 1)), undefined);
  // Path bytes that are not valid UTF-8.
  assert.equal(
    parseRsdsCodeViewRecord(
      Buffer.concat([valid.subarray(0, 24), Buffer.from([0xff, 0xfe, 0x00])]),
    ),
    undefined,
  );
});

// --- inspector linkage ------------------------------------------------------

test("extracts a module's CodeView debugFile and SymSrv debugId", () => {
  const guid = guidBytes(0xdeadbeef, 0xcafe, 0x1234, [0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]);
  const modules = inspectModulesOf(
    syntheticMinidump({
      modules: [
        {
          name: "C:\\app\\renderer.exe",
          baseOfImage: 0x7ff612340000n,
          cvRecordBytes: rsdsRecord("C:\\build\\out\\renderer.pdb", guid, 0xab),
        },
      ],
    }),
  );

  assert.deepEqual(modules, [
    {
      name: "C:\\app\\renderer.exe",
      baseOfImage: 0x7ff612340000n,
      sizeOfImage: 0x1000,
      timestamp: 0,
      debugFile: "renderer.pdb",
      debugId: "DEADBEEFCAFE12340011223344556677AB",
    },
  ]);
});

test("omits linkage fields when the CvRecord is absent or declares zero size", () => {
  const noRecord = syntheticMinidump({ modules: [{ name: "a.dll" }] });
  const [module] = inspectModulesOf(noRecord);
  assert.deepEqual(module, {
    name: "a.dll",
    baseOfImage: 0x140000000n,
    sizeOfImage: 0x1000,
    timestamp: 0,
  });
  if (module === undefined) return;
  assert.equal("debugFile" in module, false);
  assert.equal("debugId" in module, false);

  // Rva that happens to be valid but DataSize === 0 still means "no identity".
  const zeroSize = syntheticMinidump({ modules: [{ name: "a.dll" }] });
  const zeroSizeStreamRva = zeroSize.readUInt32LE(directoryOffset(0) + 8);
  zeroSize.writeUInt32LE(4, zeroSizeStreamRva + 4 + 80);
  const [zeroSizeModule] = inspectModulesOf(zeroSize);
  if (zeroSizeModule === undefined) return;
  assert.equal("debugFile" in zeroSizeModule, false);
});

test("omits linkage when the CvRecord Rva points beyond the file", () => {
  const bytes = syntheticMinidump({
    modules: [
      {
        name: "a.dll",
        cvRecordBytes: rsdsRecord("C:\\out\\a.pdb", canonicalGuidBytes(), 1),
      },
    ],
  });
  const streamRva = bytes.readUInt32LE(directoryOffset(0) + 8);
  bytes.writeUInt32LE(bytes.length + 0x1000, streamRva + 4 + 80); // CvRecord.Rva

  const modules = inspectModulesOf(bytes);
  const [module] = modules;
  assert.equal(modules.length, 1);
  if (module === undefined) return;
  assert.equal("debugFile" in module, false);
  assert.equal("debugId" in module, false);
});

test("omits linkage when the declared CvRecord size runs past the file", () => {
  const bytes = syntheticMinidump({
    modules: [
      {
        name: "a.dll",
        cvRecordBytes: rsdsRecord("C:\\out\\a.pdb", canonicalGuidBytes(), 1),
      },
    ],
  });
  const streamRva = bytes.readUInt32LE(directoryOffset(0) + 8);
  bytes.writeUInt32LE(0x10000, streamRva + 4 + 76); // CvRecord.DataSize

  const modules = inspectModulesOf(bytes);
  const [module] = modules;
  assert.equal(modules.length, 1);
  if (module === undefined) return;
  assert.equal("debugFile" in module, false);
});

test("omits linkage for non-RSDS CvRecord bytes", () => {
  const modules = inspectModulesOf(
    syntheticMinidump({
      modules: [
        {
          name: "a.dll",
          cvRecordBytes: Buffer.concat([Buffer.from("NB10", "latin1"), Buffer.alloc(64, 0x5a)]),
        },
      ],
    }),
  );

  const [module] = modules;
  if (module === undefined) return;
  assert.equal("debugFile" in module, false);
  assert.equal("debugId" in module, false);
});

test("keeps linkage best-effort across a mix of modules", () => {
  const guid = canonicalGuidBytes();
  const modules = inspectModulesOf(
    syntheticMinidump({
      modules: [
        { name: "one.dll", cvRecordBytes: rsdsRecord("C:\\out\\one.pdb", guid, 1) },
        { name: "two.dll" },
        {
          name: "three.dll",
          cvRecordBytes: Buffer.concat([Buffer.from("NB10", "latin1"), Buffer.alloc(64, 0x5a)]),
        },
      ],
    }),
  );

  assert.equal(modules.length, 3);
  assert.deepEqual(
    modules.map((module) => ({
      name: module.name,
      debugFile: module.debugFile,
      debugId: module.debugId,
    })),
    [
      { name: "one.dll", debugFile: "one.pdb", debugId: "0123456789ABCDEF0123456789ABCDEF1" },
      { name: "two.dll", debugFile: undefined, debugId: undefined },
      { name: "three.dll", debugFile: undefined, debugId: undefined },
    ],
  );
});

// --- serialized facts shape -------------------------------------------------

test("inspection port serializes linkage fields in the pinned module JSON shape", () => {
  const dumpId = parseDumpId(`dump_${"0".repeat(26)}`);
  const vault = new MemoryVault();
  vault.createStaging(dumpId);
  vault.append(
    dumpId,
    syntheticMinidump({
      modules: [
        {
          name: "renderer.exe",
          cvRecordBytes: rsdsRecord(
            "C:\\out\\renderer.pdb",
            guidBytes(0xdeadbeef, 0xcafe, 0x1234, [0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77]),
            0xab,
          ),
        },
      ],
    }),
  );
  vault.syncAndClose(dumpId);
  vault.promote(dumpId);

  const result = createVaultMinidumpInspectionPort(vault).inspect(dumpId);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.facts.modules, [
    {
      name: "renderer.exe",
      baseOfImage: "5368709120",
      sizeOfImage: 4096,
      timestamp: 0,
      debugFile: "renderer.pdb",
      debugId: "DEADBEEFCAFE12340011223344556677AB",
    },
  ]);
  assert.doesNotThrow(() => JSON.stringify(result.facts));
});
