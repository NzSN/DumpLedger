import assert from "node:assert/strict";
import { test } from "node:test";

import { DumpLedgerError } from "../../src/domain/errors.js";
import {
  byteReaderOf,
  decodeStorePath,
  encodeStorePath,
  parsePeIdentity,
  parsePdbIdentity,
  parsePdbIdentityFrom,
} from "../../src/symbols/identity.js";

/**
 * Unit coverage for the symbol-identity module: synthetic MSF/RSDS containers,
 * a synthetic PE header, and the store-path codec (docs/symbols-design.md,
 * "Identity model" / "Test plan"). All fixtures are built in code -- no
 * checked-in binaries.
 */

const MSF_MAGIC = "Microsoft C/C++ MSF 7.00\r\n\u001aDS";
const DEFAULT_BLOCK_SIZE = 4096;
const PE_OPTIONAL_HEADER_BYTES = 0xf0;
const PE_SIGNATURE_OFFSET = 0x80;

/**
 * Canonical GUID 01234567-89AB-CDEF-0123-456789ABCDEF written the way a PDB
 * stores it: Data1/Data2/Data3 little-endian, Data4 in order.
 */
function canonicalGuidBytes(): Buffer {
  return guidBytes(0x01234567, 0x89ab, 0xcdef, [0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]);
}

function guidBytes(data1: number, data2: number, data3: number, data4: readonly number[]): Buffer {
  const bytes = Buffer.alloc(16);
  bytes.writeUInt32LE(data1 >>> 0, 0);
  bytes.writeUInt16LE(data2, 4);
  bytes.writeUInt16LE(data3, 6);
  for (const [index, value] of data4.entries()) bytes[8 + index] = value;
  return bytes;
}

/** PDB Info stream versions (PdbImpV); VC70x is what lld writes. */
const PDB_INFO_VERSION_VC140 = 20140508;
const PDB_INFO_VERSION_VC70X = 20000404;

/**
 * The 28-byte header that opens the PDB Info stream (stream 1) of a real
 * PDB: version, signature, age, GUID. There is no fourcc and no file path
 * inside a PDB -- the "RSDS" record carrying the path lives in the consumer
 * (the executable's debug directory; the minidump's CvRecord copy).
 */
function pdbInfoHeader(guid: Buffer, age: number, options: { readonly version?: number; readonly signature?: number } = {}): Buffer {
  const header = Buffer.alloc(4 + 4 + 4 + 16);
  header.writeUInt32LE(options.version ?? PDB_INFO_VERSION_VC140, 0);
  header.writeUInt32LE(options.signature ?? 0x5dc5d9be, 4);
  header.writeUInt32LE(age >>> 0, 8);
  guid.copy(header, 12);
  return header;
}

interface MsfLayout {
  readonly bytes: Buffer;
  readonly blockSize: number;
  readonly directoryStartBlock: number;
  readonly blockMapStartBlock: number;
  readonly streamStartBlocks: readonly number[];
}

/** Minimal but structurally faithful MSF 7.0 container around the given streams. */
function buildMsf(
  streams: readonly Buffer[],
  options: { readonly blockSize?: number; readonly gapBlocksBeforeDirectory?: number } = {},
): MsfLayout {
  const blockSize = options.blockSize ?? DEFAULT_BLOCK_SIZE;
  const streamStartBlocks: number[] = [];
  let nextBlock = 1;
  for (const stream of streams) {
    streamStartBlocks.push(nextBlock);
    nextBlock += Math.ceil(stream.length / blockSize);
  }

  // MSF 7.0 directory: stream count, the size table, then one uint32 block
  // list per stream (real MSF does not guarantee consecutive stream layout).
  const streamBlockCounts = streams.map((stream) => Math.ceil(stream.length / blockSize));
  const directoryBytes = 4 + streams.length * 4 + streamBlockCounts.reduce((sum, count) => sum + count, 0) * 4;
  const directory = Buffer.alloc(directoryBytes);
  directory.writeUInt32LE(streams.length, 0);
  let listOffset = 4 + streams.length * 4;
  streams.forEach((stream, index) => {
    directory.writeUInt32LE(stream.length, 4 + index * 4);
    for (let block = 0; block < streamBlockCounts[index]!; block += 1) {
      directory.writeUInt32LE(streamStartBlocks[index]! + block, listOffset + block * 4);
    }
    listOffset += streamBlockCounts[index]! * 4;
  });
  // Real multi-GB PDBs keep their stream directory far from the prefix;
  // the gap reproduces that layout without gigabytes of fixture bytes.
  const directoryStartBlock = nextBlock + (options.gapBlocksBeforeDirectory ?? 0);
  nextBlock = directoryStartBlock;
  const directoryBlockCount = Math.ceil(directory.length / blockSize);
  nextBlock += directoryBlockCount;

  // The block map lists the directory's blocks first, then its own blocks.
  let blockMapBlockCount = Math.ceil(directoryBlockCount * 4 / blockSize);
  while ((directoryBlockCount + blockMapBlockCount) * 4 > blockMapBlockCount * blockSize) {
    blockMapBlockCount += 1;
  }
  const blockMapStartBlock = nextBlock;
  nextBlock += blockMapBlockCount;
  const numBlocks = nextBlock;

  const bytes = Buffer.alloc(numBlocks * blockSize);
  bytes.write(MSF_MAGIC, 0, "latin1");
  bytes.writeUInt32LE(blockSize, 32);
  bytes.writeUInt32LE(1, 36); // free block map block
  bytes.writeUInt32LE(numBlocks, 40);
  bytes.writeUInt32LE(directory.length, 44);
  bytes.writeUInt32LE(0, 48); // unknown
  bytes.writeUInt32LE(blockMapStartBlock, 52);
  streams.forEach((stream, index) => stream.copy(bytes, streamStartBlocks[index]! * blockSize));
  directory.copy(bytes, directoryStartBlock * blockSize);

  const mapOffset = blockMapStartBlock * blockSize;
  for (let index = 0; index < directoryBlockCount; index += 1) {
    bytes.writeUInt32LE(directoryStartBlock + index, mapOffset + index * 4);
  }
  for (let index = 0; index < blockMapBlockCount; index += 1) {
    bytes.writeUInt32LE(blockMapStartBlock + index, mapOffset + (directoryBlockCount + index) * 4);
  }
  return { bytes, blockSize, directoryStartBlock, blockMapStartBlock, streamStartBlocks };
}

interface SyntheticPdbOptions {
  readonly guid?: Buffer;
  readonly age?: number;
  readonly version?: number;
  readonly signature?: number;
  readonly blockSize?: number;
  readonly infoStream?: Buffer;
  readonly gapBlocksBeforeDirectory?: number;
}

function syntheticPdb(options: SyntheticPdbOptions = {}): MsfLayout {
  const guid = options.guid ?? canonicalGuidBytes();
  const infoStream =
    options.infoStream ??
    pdbInfoHeader(guid, options.age ?? 1, { ...(options.version === undefined ? {} : { version: options.version }), ...(options.signature === undefined ? {} : { signature: options.signature }) });
  const streams = [Buffer.from([0x01, 0x02, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]), infoStream];
  return buildMsf(streams, {
    blockSize: options.blockSize ?? DEFAULT_BLOCK_SIZE,
    gapBlocksBeforeDirectory: options.gapBlocksBeforeDirectory ?? 0,
  });
}

interface SyntheticPeOptions {
  readonly eLfanew?: number;
  readonly timestamp?: number;
  readonly sizeOfImage?: number;
  readonly sizeOfOptionalHeader?: number;
  readonly optionalMagic?: number;
}

function syntheticPe(options: SyntheticPeOptions = {}): Buffer {
  const eLfanew = options.eLfanew ?? PE_SIGNATURE_OFFSET;
  const sizeOfOptionalHeader = options.sizeOfOptionalHeader ?? PE_OPTIONAL_HEADER_BYTES;
  const bytes = Buffer.alloc(eLfanew + 4 + 20 + sizeOfOptionalHeader);
  bytes.writeUInt16LE(0x5a4d, 0); // "MZ"
  bytes.writeUInt32LE(eLfanew, 0x3c);
  bytes.write("PE\0\0", eLfanew, "latin1");
  const coff = eLfanew + 4;
  bytes.writeUInt16LE(0x8664, coff); // Machine: AMD64
  bytes.writeUInt16LE(3, coff + 2); // NumberOfSections
  bytes.writeUInt32LE(options.timestamp ?? 0x5dc5d9be, coff + 4);
  bytes.writeUInt32LE(0, coff + 8); // PointerToSymbolTable
  bytes.writeUInt32LE(0, coff + 12); // NumberOfSymbols
  bytes.writeUInt16LE(sizeOfOptionalHeader, coff + 16);
  bytes.writeUInt16LE(0x22, coff + 18); // Characteristics
  if (sizeOfOptionalHeader >= 60) {
    const optional = coff + 20;
    bytes.writeUInt16LE(options.optionalMagic ?? 0x20b, optional); // PE32+
    bytes.writeUInt32LE(options.sizeOfImage ?? 0x12b000, optional + 56);
  }
  return bytes;
}

function assertUnreadable(action: () => unknown): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof DumpLedgerError, `expected DumpLedgerError, got ${String(error)}`);
    assert.equal(error.code, "symbol_identity_unreadable");
    return true;
  });
}

function assertInvalidInput(action: () => unknown): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof DumpLedgerError, `expected DumpLedgerError, got ${String(error)}`);
    assert.equal(error.code, "invalid_input");
    return true;
  });
}

// --- PDB identity -----------------------------------------------------------

test("parsePdbIdentity derives debugId from the PDB Info stream header", () => {
  const identity = parsePdbIdentity(syntheticPdb().bytes, "electron.pdb");

  assert.deepEqual(identity, {
    debugFile: "electron.pdb",
    debugId: "0123456789ABCDEF0123456789ABCDEF1",
  });
});

test("parsePdbIdentity reverses the first three GUID components", () => {
  const guid = canonicalGuidBytes();
  // On disk the components are little-endian: 67 45 23 01, AB 89, EF CD, ...
  assert.deepEqual(
    [...guid.subarray(0, 8)],
    [0x67, 0x45, 0x23, 0x01, 0xab, 0x89, 0xef, 0xcd],
  );

  const identity = parsePdbIdentity(syntheticPdb({ guid }).bytes, "electron.pdb");
  assert.equal(identity?.debugId, "0123456789ABCDEF0123456789ABCDEF1");
});

test("parsePdbIdentity pads GUID components that lose leading zeros", () => {
  const guid = guidBytes(0x00000001, 0x0012, 0x0034, [0, 0, 0, 0, 0, 0, 0, 0xab]);
  const identity = parsePdbIdentity(syntheticPdb({ guid, age: 0 }).bytes, "electron.pdb");

  assert.equal(identity?.debugId, "000000010012003400000000000000AB0");
});

for (const [age, suffix] of [[0, "0"], [1, "1"], [0x1234, "1234"], [0xabcdef01, "ABCDEF01"]] as const) {
  test(`parsePdbIdentity formats age ${age} as ${suffix}`, () => {
    const identity = parsePdbIdentity(syntheticPdb({ age }).bytes, "electron.pdb");

    assert.equal(identity?.debugId, `0123456789ABCDEF0123456789ABCDEF${suffix}`);
  });
}

test("parsePdbIdentity takes the debug file name from the caller", () => {
  // The PDB Info stream carries version/signature/age/GUID and NO path; the
  // name comes from the ingest filename (mirroring EXE codeFile), because
  // the consumer-side RSDS record is what carries the linked path.
  const identity = parsePdbIdentity(syntheticPdb().bytes, "electron.exe.pdb");
  assert.equal(identity?.debugFile, "electron.exe.pdb");
  assert.equal(identity?.debugId, "0123456789ABCDEF0123456789ABCDEF1");
});

test("parsePdbIdentity rejects an unusable debug file name", () => {
  const unusable = ["", ".", "..", ".hidden.pdb", "trail.", "a..b.pdb", "dir/file.pdb", "dir\\file.pdb", "bad\u0001.pdb", "a".repeat(256)];
  for (const debugFile of unusable) {
    assertInvalidInput(() => parsePdbIdentity(syntheticPdb().bytes, debugFile));
  }
});

test("parsePdbIdentity returns undefined for bytes that are not an MSF container", () => {
  assert.equal(parsePdbIdentity(Buffer.alloc(0), "electron.pdb"), undefined);
  assert.equal(parsePdbIdentity(Buffer.from(MSF_MAGIC), "electron.pdb"), undefined); // magic only, 29 bytes
  assert.equal(parsePdbIdentity(Buffer.alloc(64), "electron.pdb"), undefined);
  assert.equal(parsePdbIdentity(Buffer.from("MZ not a pdb at all"), "electron.pdb"), undefined);

  const flipped = Buffer.from(syntheticPdb().bytes);
  flipped[27] = 0x45; // "DS" -> "ES" inside the magic
  assert.equal(parsePdbIdentity(flipped, "electron.pdb"), undefined);
});

test("parsePdbIdentity rejects a PDB whose superblock is truncated", () => {
  assertUnreadable(() => parsePdbIdentity(syntheticPdb().bytes.subarray(0, 40), "electron.pdb"));
});

test("parsePdbIdentity rejects an unsupported block size", () => {
  for (const blockSize of [0, 24, 256, 3000]) {
    const bytes = Buffer.from(syntheticPdb().bytes);
    bytes.writeUInt32LE(blockSize, 32);
    assertUnreadable(() => parsePdbIdentity(bytes, "electron.pdb"));
  }

  const huge = Buffer.from(syntheticPdb().bytes);
  huge.writeUInt32LE(1 << 30, 32); // valid power of two, larger than the artifact
  assertUnreadable(() => parsePdbIdentity(huge, "electron.pdb"));
});

test("parsePdbIdentity rejects a block map address outside the artifact", () => {
  const bytes = Buffer.from(syntheticPdb().bytes);
  bytes.writeUInt32LE(0xffffffff, 52);

  assertUnreadable(() => parsePdbIdentity(bytes, "electron.pdb"));
});

test("parsePdbIdentity rejects a directory block index outside the artifact", () => {
  const layout = syntheticPdb();
  const bytes = Buffer.from(layout.bytes);
  bytes.writeUInt32LE(0xffffffff, layout.blockMapStartBlock * layout.blockSize);

  assertUnreadable(() => parsePdbIdentity(bytes, "electron.pdb"));
});

test("parsePdbIdentity rejects a container without a PDB Info stream", () => {
  const layout = buildMsf([Buffer.from([1, 2, 3, 4])]);

  assertUnreadable(() => parsePdbIdentity(layout.bytes, "electron.pdb"));
});

test("parsePdbIdentity rejects an unknown PDB Info stream version", () => {
  const infoStream = pdbInfoHeader(canonicalGuidBytes(), 1, { version: 0x01010101 });

  assertUnreadable(() => parsePdbIdentity(syntheticPdb({ infoStream }).bytes, "electron.pdb"));
});

test("parsePdbIdentity rejects a PDB Info stream smaller than its 28-byte header", () => {
  assertUnreadable(() => parsePdbIdentity(syntheticPdb({ infoStream: Buffer.alloc(27) }).bytes, "electron.pdb"));
});

test("parsePdbIdentity handles a zero-length stream 0", () => {
  const infoStream = pdbInfoHeader(canonicalGuidBytes(), 1);
  const layout = buildMsf([Buffer.alloc(0), infoStream]);

  assert.deepEqual(parsePdbIdentity(layout.bytes, "electron.pdb"), {
    debugFile: "electron.pdb",
    debugId: "0123456789ABCDEF0123456789ABCDEF1",
  });
});

test("parsePdbIdentity walks a multi-block stream directory and block map", () => {
  // 16384 streams make the 65540-byte directory span 129 512-byte blocks,
  // so the 516-byte block-map prefix spans two blocks as well.
  const infoStream = pdbInfoHeader(canonicalGuidBytes(), 0x2a);
  const streams = [Buffer.alloc(8), infoStream, ...Array.from({ length: 16382 }, () => Buffer.alloc(0))];
  const layout = buildMsf(streams, { blockSize: 512 });

  assert.deepEqual(parsePdbIdentity(layout.bytes, "electron.pdb"), {
    debugFile: "electron.pdb",
    debugId: "0123456789ABCDEF0123456789ABCDEF2A",
  });
});

// --- PE identity ------------------------------------------------------------

test("parsePeIdentity concatenates the COFF timestamp and the image size", () => {
  assert.deepEqual(parsePeIdentity(syntheticPe(), "electron.exe"), {
    codeFile: "electron.exe",
    codeId: "5DC5D9BE12B000",
  });
});

test("parsePeIdentity pads the timestamp to eight hex digits", () => {
  assert.deepEqual(parsePeIdentity(syntheticPe({ timestamp: 0x00abcdef, sizeOfImage: 0x1000 }), "x.exe"), {
    codeFile: "x.exe",
    codeId: "00ABCDEF1000",
  });
});

test("parsePeIdentity reads the SizeOfImage offset of a PE32 header too", () => {
  assert.deepEqual(parsePeIdentity(syntheticPe({ optionalMagic: 0x10b, sizeOfImage: 0x400000 }), "x86.exe"), {
    codeFile: "x86.exe",
    codeId: "5DC5D9BE400000",
  });
});

test("parsePeIdentity returns undefined for input that is not a PE image", () => {
  assert.equal(parsePeIdentity(Buffer.from("not a pe image at all"), "x.exe"), undefined);
  assert.equal(parsePeIdentity(Buffer.from("MZ"), "x.exe"), undefined);
  assert.equal(parsePeIdentity(Buffer.alloc(64), "x.exe"), undefined);

  const beyondEnd = syntheticPe();
  beyondEnd.writeUInt32LE(0xffffffff, 0x3c);
  assert.equal(parsePeIdentity(beyondEnd, "x.exe"), undefined);

  const wrongSignature = syntheticPe();
  wrongSignature.write("XX\0\0", PE_SIGNATURE_OFFSET, "latin1");
  assert.equal(parsePeIdentity(wrongSignature, "x.exe"), undefined);

  const tinyOptionalHeader = syntheticPe({ sizeOfOptionalHeader: 56 });
  assert.equal(parsePeIdentity(tinyOptionalHeader, "x.exe"), undefined);

  const truncatedBeforeSizeOfImage = syntheticPe().subarray(0, PE_SIGNATURE_OFFSET + 4 + 20 + 59);
  assert.equal(parsePeIdentity(truncatedBeforeSizeOfImage, "x.exe"), undefined);
});

test("parsePeIdentity rejects an unusable code file name", () => {
  const unusable = ["", ".", "..", ".hidden.exe", "trail.", "a..b.exe", "dir/file.exe", "dir\\file.exe", "bad\u0001.exe", "a".repeat(256)];

  for (const codeFile of unusable) {
    assertInvalidInput(() => parsePeIdentity(syntheticPe(), codeFile));
  }
});

// --- Store path codec -------------------------------------------------------

test("encodeStorePath builds the three-segment SymSrv path", () => {
  assert.equal(
    encodeStorePath("electron.pdb", "0123456789ABCDEF0123456789ABCDEF1"),
    "electron.pdb/0123456789ABCDEF0123456789ABCDEF1/electron.pdb",
  );
});

test("decodeStorePath round-trips encodeStorePath", () => {
  const cases = [
    ["electron.pdb", "0123456789ABCDEF0123456789ABCDEF1"],
    ["a", "AB"],
    ["名前.pdb", "FF00"],
  ] as const;

  for (const [debugFile, debugId] of cases) {
    assert.deepEqual(decodeStorePath(encodeStorePath(debugFile, debugId)), {
      debugFile,
      debugId,
      file: debugFile,
    });
  }
});

test("decodeStorePath returns the segments without requiring file === debugFile", () => {
  assert.deepEqual(decodeStorePath("a/AB/b"), { debugFile: "a", debugId: "AB", file: "b" });
});

test("decodeStorePath rejects paths that are not three valid segments", () => {
  const rejected = [
    "",
    "electron.pdb",
    "electron.pdb/AB",
    "electron.pdb/AB/electron.pdb/extra",
    "/electron.pdb/AB/electron.pdb",
    "electron.pdb/AB/electron.pdb/",
    "electron.pdb//electron.pdb",
    "electron.pdb/ab/electron.pdb", // lowercase id
    "electron.pdb/A/electron.pdb", // one-character id
    "electron.pdb/AB-1/electron.pdb",
    `electron.pdb/${"A".repeat(65)}/electron.pdb`,
    "electron.pdb/GG/electron.pdb",
    "electron.pdb/AB/electron.pdb\\x",
    "..pdb/AB/..pdb",
    ".pdb/AB/.pdb",
    "trail./AB/trail.",
    "a..b/AB/a..b",
    `${"a".repeat(256)}/AB/${"a".repeat(256)}`,
    "bad\u0001name.pdb/AB/bad\u0001name.pdb",
  ];

  for (const path of rejected) {
    assert.equal(decodeStorePath(path), undefined, path);
  }
});

test("encodeStorePath rejects invalid debug files", () => {
  const badNames = ["", ".", "..", ".hidden", "trail.", "a..b", "dir/file", "dir\\file", "bad\u0001", "a".repeat(256)];

  for (const debugFile of badNames) {
    assertInvalidInput(() => encodeStorePath(debugFile, "AB"));
  }
});

test("encodeStorePath rejects debug ids that are not 2..64 uppercase hex characters", () => {
  for (const debugId of ["", "A", "abcdef", "AB-1", "GG", "A".repeat(65)]) {
    assertInvalidInput(() => encodeStorePath("x.pdb", debugId));
  }
});

test("a parsed PDB identity encodes into a decodable store path", () => {
  const identity = parsePdbIdentity(syntheticPdb().bytes, "electron.pdb");
  assert.ok(identity !== undefined);

  const path = encodeStorePath(identity.debugFile, identity.debugId);
  assert.equal(path, "electron.pdb/0123456789ABCDEF0123456789ABCDEF1/electron.pdb");
  assert.deepEqual(decodeStorePath(path), {
    debugFile: "electron.pdb",
    debugId: "0123456789ABCDEF0123456789ABCDEF1",
    file: "electron.pdb",
  });
});

test("parsePdbIdentityFrom resolves an identity whose stream directory lives beyond 1 MiB", () => {
  // A real multi-GB PDB keeps its MSF stream directory in blocks that can
  // sit anywhere in the file; the operator route and transfer import
  // therefore parse identity from the full staged bytes via the random-access
  // reader, never from a prefix window. 400 gap blocks at 4 KiB place the
  // directory past the 1 MiB mark the old window used to enforce.
  const sparse = syntheticPdb({
    gapBlocksBeforeDirectory: 400,
    blockSize: 4096,
  });
  assert.ok(sparse.directoryStartBlock * 4096 > 1024 * 1024);

  const identity = parsePdbIdentityFrom(byteReaderOf(sparse.bytes), "electron.pdb");
  assert.equal(identity?.debugFile, "electron.pdb");
  assert.equal(identity?.debugId, "0123456789ABCDEF0123456789ABCDEF1");

  // The buffer API parses the same bytes identically.
  assert.deepEqual(parsePdbIdentity(sparse.bytes, "electron.pdb"), identity);

  // ...while a 1 MiB prefix of the same artifact is unparseable, documenting
  // why prefix-window identity extraction cannot work for real PDBs.
  assertUnreadable(() => parsePdbIdentity(sparse.bytes.subarray(0, 1024 * 1024), "electron.pdb"));
});

test("parsePdbIdentity accepts the lld-written header shape of the real electron.exe.pdb", () => {
  // Ground-truth layout captured from the 3.5 GiB lld PDB (2026-09-18):
  // version VC70x, signature == GUID Data1, age 1, and the "LLD PDB." marker
  // in the GUID's Data4. The debugId prints Data1/Data2/Data3 in on-disk
  // little-endian order: bytes `fb 7f 87 a7` -> "A7877FFB", `f2 94` -> "94F2",
  // `3e db` -> "DB3E", then Data4 literal -- the id CDB/symsrv will request.
  const guid = Buffer.from([0xfb, 0x7f, 0x87, 0xa7, 0xf2, 0x94, 0x3e, 0xdb, 0x4c, 0x4c, 0x44, 0x20, 0x50, 0x44, 0x42, 0x2e]);
  const infoStream = pdbInfoHeader(guid, 1, { version: PDB_INFO_VERSION_VC70X, signature: 0xfb7f87a7 });
  const identity = parsePdbIdentity(syntheticPdb({ infoStream }).bytes, "electron.exe.pdb");

  assert.deepEqual(identity, {
    debugFile: "electron.exe.pdb",
    debugId: "A7877FFB94F2DB3E4C4C44205044422E1",
  });
});
