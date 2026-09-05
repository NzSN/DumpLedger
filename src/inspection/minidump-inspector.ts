import type { RandomAccessSource } from "./random-access-source.js";

const HEADER_SIZE = 32n;
const DIRECTORY_ENTRY_SIZE = 12n;
const MINIDUMP_VERSION = 0xa793;
const MINI_DUMP_WITH_FULL_MEMORY = 0x2n;

const MAX_STREAMS = 4096;
const MAX_MEMORY_RANGES = 65_536;
const MAX_MODULES = 4096;
const MAX_STRING_BYTES = 65_536;
const MAX_SINGLE_READ = 65_536;
const UINT64_MAX = 0xffff_ffff_ffff_ffffn;

const STREAM_TYPE = {
  moduleList: 4,
  memoryList: 5,
  exception: 6,
  systemInfo: 7,
  memory64List: 9,
  memoryInfoList: 16,
} as const;

const CRITICAL_STREAM_TYPES = new Set<number>(Object.values(STREAM_TYPE));

export type DumpCoverage = "partial" | "full-memory-declared" | "unknown";

export interface ModuleFact {
  readonly name?: string;
  readonly baseOfImage: bigint;
  readonly sizeOfImage: number;
  readonly timestamp: number;
}

export interface MinidumpFacts {
  readonly coverage: DumpCoverage;
  readonly minidumpFlags: bigint;
  /** Sum of declared captured ranges; not deduplicated virtual-address coverage. */
  readonly capturedMemoryBytes: bigint;
  readonly memoryRangeCount: number;
  readonly hasMemoryListStream: boolean;
  readonly hasMemory64ListStream: boolean;
  readonly architecture?: string;
  readonly exceptionCode?: bigint;
  readonly exceptionAddress?: bigint;
  readonly modules?: readonly ModuleFact[];
}

export type InspectionErrorCode =
  | "invalid-signature"
  | "unsupported-version"
  | "truncated"
  | "impossible-count"
  | "arithmetic-overflow"
  | "duplicate-stream"
  | "malformed-stream"
  | "resource-limit"
  | "io-error";

export interface InspectionError {
  readonly code: InspectionErrorCode;
  readonly message: string;
}

export type InspectionResult =
  | { readonly ok: true; readonly facts: MinidumpFacts }
  | { readonly ok: false; readonly error: InspectionError };

export interface DumpInspector {
  inspect(source: RandomAccessSource): InspectionResult;
}

interface DirectoryEntry {
  readonly type: number;
  readonly dataSize: bigint;
  readonly rva: bigint;
}

interface MemoryFacts {
  readonly bytes: bigint;
  readonly ranges: number;
}

class InspectionFailure extends Error {
  constructor(
    readonly code: InspectionErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Performs structural inspection only; it never reads captured memory payload bytes. */
export class MinidumpInspector implements DumpInspector {
  inspect(source: RandomAccessSource): InspectionResult {
    try {
      return { ok: true, facts: inspectMinidump(source) };
    } catch (error: unknown) {
      if (error instanceof InspectionFailure) {
        return { ok: false, error: { code: error.code, message: error.message } };
      }
      return {
        ok: false,
        error: {
          code: "io-error",
          message: error instanceof Error ? error.message : "random-access read failed",
        },
      };
    }
  }
}

function inspectMinidump(source: RandomAccessSource): MinidumpFacts {
  const header = readExact(source, 0n, Number(HEADER_SIZE), "minidump header");
  if (header.toString("ascii", 0, 4) !== "MDMP") {
    fail("invalid-signature", "minidump signature is not MDMP");
  }

  const version = header.readUInt32LE(4);
  if ((version & 0xffff) !== MINIDUMP_VERSION) {
    fail("unsupported-version", `unsupported minidump version 0x${version.toString(16)}`);
  }

  const streamCount = header.readUInt32LE(8);
  if (streamCount > MAX_STREAMS) {
    fail("impossible-count", `stream count ${streamCount} exceeds ${MAX_STREAMS}`);
  }
  const directoryRva = BigInt(header.readUInt32LE(12));
  if (streamCount > 0 && directoryRva < HEADER_SIZE) {
    fail("malformed-stream", "stream directory overlaps the minidump header");
  }
  const directoryBytes = checkedMultiply(
    BigInt(streamCount),
    DIRECTORY_ENTRY_SIZE,
    "stream directory size",
  );
  ensureRange(source, directoryRva, directoryBytes, "stream directory");

  const entries: DirectoryEntry[] = [];
  const seenCritical = new Set<number>();
  for (let index = 0; index < streamCount; index += 1) {
    const entryOffset = checkedAdd(
      directoryRva,
      checkedMultiply(BigInt(index), DIRECTORY_ENTRY_SIZE, "directory entry offset"),
      "directory entry offset",
    );
    const bytes = readExact(source, entryOffset, Number(DIRECTORY_ENTRY_SIZE), "directory entry");
    const entry: DirectoryEntry = {
      type: bytes.readUInt32LE(0),
      dataSize: BigInt(bytes.readUInt32LE(4)),
      rva: BigInt(bytes.readUInt32LE(8)),
    };
    if (entry.dataSize > 0n) ensureRange(source, entry.rva, entry.dataSize, "stream data");
    if (CRITICAL_STREAM_TYPES.has(entry.type)) {
      if (seenCritical.has(entry.type)) {
        fail("duplicate-stream", `critical stream type ${entry.type} occurs more than once`);
      }
      seenCritical.add(entry.type);
    }
    entries.push(entry);
  }

  const memoryList = findEntry(entries, STREAM_TYPE.memoryList);
  const memory64List = findEntry(entries, STREAM_TYPE.memory64List);
  const memoryInfoList = findEntry(entries, STREAM_TYPE.memoryInfoList);
  if (memoryInfoList !== undefined) inspectMemoryInfoList(source, memoryInfoList);
  const memoryListFacts = memoryList === undefined
    ? { bytes: 0n, ranges: 0 }
    : inspectMemoryList(source, memoryList);
  const memory64Facts = memory64List === undefined
    ? { bytes: 0n, ranges: 0 }
    : inspectMemory64List(source, memory64List);
  const capturedMemoryBytes = checkedAdd(
    memoryListFacts.bytes,
    memory64Facts.bytes,
    "captured memory byte total",
  );

  const flags = header.readBigUInt64LE(24);
  const hasMemoryListStream = memoryList !== undefined;
  const hasMemory64ListStream = memory64List !== undefined;
  const hasCapturedMemoryStream = hasMemoryListStream || hasMemory64ListStream;
  const coverage: DumpCoverage = (flags & MINI_DUMP_WITH_FULL_MEMORY) !== 0n
    ? "full-memory-declared"
    : hasCapturedMemoryStream
      ? "partial"
      : "unknown";

  const systemInfo = findEntry(entries, STREAM_TYPE.systemInfo);
  const exception = findEntry(entries, STREAM_TYPE.exception);
  const moduleList = findEntry(entries, STREAM_TYPE.moduleList);
  const architecture = systemInfo === undefined
    ? undefined
    : inspectArchitecture(source, systemInfo);
  const exceptionFacts = exception === undefined
    ? undefined
    : inspectException(source, exception);
  const modules = moduleList === undefined
    ? undefined
    : inspectModules(source, moduleList);

  return {
    coverage,
    minidumpFlags: flags,
    capturedMemoryBytes,
    memoryRangeCount: memoryListFacts.ranges + memory64Facts.ranges,
    hasMemoryListStream,
    hasMemory64ListStream,
    ...(architecture === undefined ? {} : { architecture }),
    ...(exceptionFacts === undefined ? {} : exceptionFacts),
    ...(modules === undefined ? {} : { modules }),
  };
}

function inspectMemoryList(source: RandomAccessSource, entry: DirectoryEntry): MemoryFacts {
  requireStreamBytes(entry, 4n, "MemoryListStream header");
  const count = readExact(source, entry.rva, 4, "MemoryListStream count").readUInt32LE(0);
  if (count > MAX_MEMORY_RANGES) {
    fail("impossible-count", `memory range count ${count} exceeds ${MAX_MEMORY_RANGES}`);
  }
  const descriptorBytes = checkedMultiply(BigInt(count), 16n, "MemoryListStream descriptors");
  requireStreamBytes(
    entry,
    checkedAdd(4n, descriptorBytes, "MemoryListStream size"),
    "MemoryListStream descriptors",
  );

  let capturedBytes = 0n;
  for (let index = 0; index < count; index += 1) {
    const offset = checkedAdd(
      entry.rva,
      checkedAdd(4n, checkedMultiply(BigInt(index), 16n, "memory descriptor offset"), "memory descriptor offset"),
      "memory descriptor offset",
    );
    const descriptor = readExact(source, offset, 16, "memory descriptor");
    const virtualAddress = descriptor.readBigUInt64LE(0);
    const dataSize = BigInt(descriptor.readUInt32LE(8));
    const dataRva = BigInt(descriptor.readUInt32LE(12));
    checkedAdd(virtualAddress, dataSize, "memory virtual range");
    ensureRange(source, dataRva, dataSize, "captured memory range");
    capturedBytes = checkedAdd(capturedBytes, dataSize, "captured memory byte total");
  }
  return { bytes: capturedBytes, ranges: count };
}

function inspectMemory64List(source: RandomAccessSource, entry: DirectoryEntry): MemoryFacts {
  requireStreamBytes(entry, 16n, "Memory64ListStream header");
  const header = readExact(source, entry.rva, 16, "Memory64ListStream header");
  const count64 = header.readBigUInt64LE(0);
  if (count64 > BigInt(MAX_MEMORY_RANGES)) {
    fail("impossible-count", `memory range count ${count64} exceeds ${MAX_MEMORY_RANGES}`);
  }
  const count = Number(count64);
  const descriptorBytes = checkedMultiply(count64, 16n, "Memory64ListStream descriptors");
  requireStreamBytes(
    entry,
    checkedAdd(16n, descriptorBytes, "Memory64ListStream size"),
    "Memory64ListStream descriptors",
  );

  let capturedBytes = 0n;
  for (let index = 0; index < count; index += 1) {
    const offset = checkedAdd(
      entry.rva,
      checkedAdd(16n, checkedMultiply(BigInt(index), 16n, "memory64 descriptor offset"), "memory64 descriptor offset"),
      "memory64 descriptor offset",
    );
    const descriptor = readExact(source, offset, 16, "memory64 descriptor");
    const virtualAddress = descriptor.readBigUInt64LE(0);
    const dataSize = descriptor.readBigUInt64LE(8);
    checkedAdd(virtualAddress, dataSize, "memory64 virtual range");
    capturedBytes = checkedAdd(capturedBytes, dataSize, "captured memory byte total");
  }
  ensureRange(source, header.readBigUInt64LE(8), capturedBytes, "captured Memory64 payload");
  return { bytes: capturedBytes, ranges: count };
}

function inspectMemoryInfoList(source: RandomAccessSource, entry: DirectoryEntry): void {
  requireStreamBytes(entry, 16n, "MemoryInfoListStream header");
  const header = readExact(source, entry.rva, 16, "MemoryInfoListStream header");
  const headerSize = BigInt(header.readUInt32LE(0));
  const entrySize = BigInt(header.readUInt32LE(4));
  const count = header.readBigUInt64LE(8);
  if (headerSize < 16n || entrySize < 48n) {
    fail("malformed-stream", "MemoryInfoListStream has undersized records");
  }
  if (count > BigInt(MAX_MEMORY_RANGES)) {
    fail("impossible-count", `memory info count ${count} exceeds ${MAX_MEMORY_RANGES}`);
  }
  const totalSize = checkedAdd(
    headerSize,
    checkedMultiply(count, entrySize, "MemoryInfoListStream entries"),
    "MemoryInfoListStream size",
  );
  requireStreamBytes(entry, totalSize, "MemoryInfoListStream entries");
}

function inspectArchitecture(
  source: RandomAccessSource,
  entry: DirectoryEntry,
): string | undefined {
  requireStreamBytes(entry, 56n, "SystemInfoStream");
  const architecture = readExact(source, entry.rva, 2, "processor architecture").readUInt16LE(0);
  return new Map<number, string>([
    [0, "x86"],
    [5, "arm"],
    [6, "ia64"],
    [9, "x86_64"],
    [12, "arm64"],
  ]).get(architecture);
}

function inspectException(
  source: RandomAccessSource,
  entry: DirectoryEntry,
): { readonly exceptionCode: bigint; readonly exceptionAddress: bigint } {
  requireStreamBytes(entry, 160n, "ExceptionStream");
  const bytes = readExact(source, entry.rva, 36, "exception record prefix");
  const parameterCount = bytes.readUInt32LE(32);
  if (parameterCount > 15) {
    fail("impossible-count", `exception parameter count ${parameterCount} exceeds 15`);
  }
  return {
    exceptionCode: BigInt(bytes.readUInt32LE(8)),
    exceptionAddress: bytes.readBigUInt64LE(24),
  };
}

function inspectModules(source: RandomAccessSource, entry: DirectoryEntry): readonly ModuleFact[] {
  requireStreamBytes(entry, 4n, "ModuleListStream header");
  const count = readExact(source, entry.rva, 4, "ModuleListStream count").readUInt32LE(0);
  if (count > MAX_MODULES) {
    fail("impossible-count", `module count ${count} exceeds ${MAX_MODULES}`);
  }
  const descriptorBytes = checkedMultiply(BigInt(count), 108n, "ModuleListStream descriptors");
  requireStreamBytes(
    entry,
    checkedAdd(4n, descriptorBytes, "ModuleListStream size"),
    "ModuleListStream descriptors",
  );

  const modules: ModuleFact[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = checkedAdd(
      entry.rva,
      checkedAdd(4n, checkedMultiply(BigInt(index), 108n, "module descriptor offset"), "module descriptor offset"),
      "module descriptor offset",
    );
    const descriptor = readExact(source, offset, 108, "module descriptor");
    const nameRva = descriptor.readUInt32LE(20);
    const name = nameRva === 0 ? undefined : readMinidumpString(source, BigInt(nameRva));
    modules.push({
      ...(name === undefined ? {} : { name }),
      baseOfImage: descriptor.readBigUInt64LE(0),
      sizeOfImage: descriptor.readUInt32LE(8),
      timestamp: descriptor.readUInt32LE(16),
    });
  }
  return modules;
}

function readMinidumpString(source: RandomAccessSource, rva: bigint): string {
  const byteLength = readExact(source, rva, 4, "module name length").readUInt32LE(0);
  if (byteLength > MAX_STRING_BYTES) {
    fail("resource-limit", `module name length ${byteLength} exceeds ${MAX_STRING_BYTES}`);
  }
  if ((byteLength & 1) !== 0) {
    fail("malformed-stream", "module name has an odd UTF-16 byte length");
  }
  const contentsRva = checkedAdd(rva, 4n, "module name offset");
  return readExact(source, contentsRva, byteLength, "module name").toString("utf16le");
}

function findEntry(
  entries: readonly DirectoryEntry[],
  type: number,
): DirectoryEntry | undefined {
  return entries.find((entry) => entry.type === type);
}

function requireStreamBytes(
  entry: DirectoryEntry,
  required: bigint,
  context: string,
): void {
  if (required > entry.dataSize) {
    fail("malformed-stream", `${context} exceeds its declared stream size`);
  }
}

function ensureRange(
  source: RandomAccessSource,
  offset: bigint,
  size: bigint,
  context: string,
): void {
  const end = checkedAdd(offset, size, `${context} range`);
  if (end > source.size) {
    fail("truncated", `${context} extends beyond end of file`);
  }
}

function readExact(
  source: RandomAccessSource,
  offset: bigint,
  length: number,
  context: string,
): Buffer {
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_SINGLE_READ) {
    fail("resource-limit", `${context} read length is outside the bounded limit`);
  }
  ensureRange(source, offset, BigInt(length), context);
  const bytes = source.readAt(offset, length);
  if (bytes.length !== length) fail("truncated", `${context} could not be read completely`);
  return bytes;
}

function checkedAdd(left: bigint, right: bigint, context: string): bigint {
  if (left < 0n || right < 0n || left > UINT64_MAX - right) {
    fail("arithmetic-overflow", `${context} overflows an unsigned 64-bit range`);
  }
  return left + right;
}

function checkedMultiply(left: bigint, right: bigint, context: string): bigint {
  if (left < 0n || right < 0n || (right !== 0n && left > UINT64_MAX / right)) {
    fail("arithmetic-overflow", `${context} overflows an unsigned 64-bit range`);
  }
  return left * right;
}

function fail(code: InspectionErrorCode, message: string): never {
  throw new InspectionFailure(code, message);
}
