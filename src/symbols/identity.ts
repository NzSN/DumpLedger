/**
 * Symbol identity: pure functions that derive immutable PDB/PE identities from
 * artifact bytes and map them onto symsrv store paths.
 *
 * Reference: docs/symbols-design.md ("Identity model" and the resolved
 * decisions D1-D4). The module performs no I/O beyond reading the byte arrays
 * it is handed.
 *
 * Read discipline: every field read is range-checked and every allocation is
 * bounded by the input length, so corrupt input can only degrade to
 * `undefined` or to a `symbol_identity_unreadable` domain error -- never to a
 * `RangeError` or an oversized allocation.
 *
 * One deliberate exception to "unreadable input returns `undefined`": a file
 * that carries the MSF superblock magic claims to be a PDB, so a missing or
 * unreadable RSDS record is reported as `symbol_identity_unreadable`, not as
 * "not a PDB".
 */
import { DumpLedgerError, type ErrorCode } from "../domain/errors.js";

/** Debug identity of one PDB: `debugFile` (basename) and SymSrv `debugId`. */
export interface PdbIdentity {
  readonly debugFile: string;
  readonly debugId: string;
}

/** Code identity of one PE image: caller-supplied `codeFile` plus `codeId`. */
export interface PeIdentity {
  readonly codeFile: string;
  readonly codeId: string;
}

/** The three segments of a store path: `<name>/<id>/<file>`. */
export interface StorePathParts {
  readonly debugFile: string;
  readonly debugId: string;
  readonly file: string;
}

// --- MSF 7.0 / RSDS (PDB) ---------------------------------------------------

/**
 * Start of the 32-byte MSF superblock magic. The full on-disk field is
 * `"Microsoft C/C++ MSF 7.00\r\n" + 0x1A + "DS"` followed by three NUL bytes.
 */
const MSF_MAGIC = "Microsoft C/C++ MSF 7.00\r\n\u001aDS";
const MSF_SUPERBLOCK_SIZE = 32;
const MSF_BLOCK_SIZE_OFFSET = 32;
const MSF_NUM_DIRECTORY_BYTES_OFFSET = 44;
const MSF_BLOCK_MAP_ADDR_OFFSET = 52;
// Real MSF writers never go below 512 bytes; the floor also keeps the 56-byte
// superblock inside block 0, which the stream-offset math below relies on.
const MSF_MIN_BLOCK_SIZE = 512;
const MSF_MAX_BLOCK_SIZE = 1 << 30;

const RSDS_SIGNATURE = "RSDS";
/** "RSDS" signature + 16-byte GUID + 32-bit age. */
const RSDS_HEADER_BYTES = 4 + 16 + 4;
/** Upper bound on the region of the PDB Info stream scanned for the path. */
const RSDS_PATH_SCAN_MAX = 64 * 1024;

// --- PE ---------------------------------------------------------------------

const DOS_SIGNATURE = 0x5a4d; // "MZ"
const DOS_E_LFANEW_OFFSET = 0x3c;
const PE_SIGNATURE = "PE\0\0";
const COFF_HEADER_BYTES = 20;
const COFF_TIMESTAMP_OFFSET = 4;
const COFF_OPTIONAL_HEADER_SIZE_OFFSET = 16;
/** `SizeOfImage` sits at the same optional-header offset for PE32 and PE32+. */
const OPTIONAL_HEADER_SIZE_OF_IMAGE_OFFSET = 56;
const OPTIONAL_HEADER_MIN_BYTES = OPTIONAL_HEADER_SIZE_OF_IMAGE_OFFSET + 4;

// --- Store path -------------------------------------------------------------

const SEGMENT_MAX_LENGTH = 255;
const DEBUG_ID_PATTERN = /^[0-9A-F]{2,64}$/;

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function symbolIdentityUnreadable(detail: string): DumpLedgerError {
  // "symbol_identity_unreadable" is the symbols-milestone domain code
  // (docs/symbols-design.md, ingest API). The assertion keeps this module
  // compiling until the literal joins `ErrorCodes` in src/domain/errors.ts.
  return new DumpLedgerError(
    "symbol_identity_unreadable",
    `unreadable symbol identity: ${detail}`,
  );
}

function invalidInput(detail: string): DumpLedgerError {
  return new DumpLedgerError("invalid_input", detail);
}

function toDataView(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function readUint16(view: DataView, offset: number): number | undefined {
  if (!Number.isInteger(offset) || offset < 0 || offset > view.byteLength - 2) return undefined;
  return view.getUint16(offset, true);
}

function readUint32(view: DataView, offset: number): number | undefined {
  if (!Number.isInteger(offset) || offset < 0 || offset > view.byteLength - 4) return undefined;
  return view.getUint32(offset, true);
}

function matchesAscii(bytes: Uint8Array, offset: number, text: string): boolean {
  if (!Number.isInteger(offset) || offset < 0 || offset + text.length > bytes.length) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

function looksLikeMsf(bytes: Uint8Array): boolean {
  if (bytes.length < MSF_SUPERBLOCK_SIZE) return false;
  if (!matchesAscii(bytes, 0, MSF_MAGIC)) return false;
  for (let index = MSF_MAGIC.length; index < MSF_SUPERBLOCK_SIZE; index += 1) {
    if (bytes[index] !== 0) return false;
  }
  return true;
}

/**
 * Copies `byteCount` bytes starting at `startBlock`, walking consecutive
 * blocks. Returns `undefined` whenever the requested range leaves the artifact
 * or a block is not fully addressable; every multiply is guarded so indexes
 * stay inside the safe-integer range.
 */
function readConsecutiveBlocks(
  bytes: Uint8Array,
  blockSize: number,
  startBlock: number,
  byteCount: number,
): Uint8Array | undefined {
  if (!Number.isSafeInteger(startBlock) || startBlock < 0) return undefined;
  if (!Number.isSafeInteger(byteCount) || byteCount < 0) return undefined;
  const out = new Uint8Array(byteCount);
  let copied = 0;
  let block = startBlock;
  while (copied < byteCount) {
    if (!Number.isSafeInteger(block) || block < 0) return undefined;
    if (block > Math.floor(bytes.length / blockSize)) return undefined;
    const start = block * blockSize;
    const available = Math.min(blockSize, bytes.length - start);
    const take = Math.min(available, byteCount - copied);
    if (take <= 0) return undefined;
    out.set(bytes.subarray(start, start + take), copied);
    copied += take;
    block += 1;
  }
  return out;
}

/** Copies one block's readable prefix into `target`; returns the byte count. */
function copyBlockInto(
  bytes: Uint8Array,
  blockSize: number,
  block: number,
  target: Uint8Array,
  targetOffset: number,
  byteCount: number,
): number | undefined {
  if (!Number.isSafeInteger(block) || block < 0) return undefined;
  if (block > Math.floor(bytes.length / blockSize)) return undefined;
  const start = block * blockSize;
  const available = Math.min(blockSize, bytes.length - start);
  const take = Math.min(available, byteCount);
  if (take <= 0) return undefined;
  target.set(bytes.subarray(start, start + take), targetOffset);
  return take;
}

function controlCharacterIndex(value: string): number {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return index;
  }
  return -1;
}

/** Last non-empty segment of a path written with either Windows or POSIX separators. */
function fileNameFromPath(path: string): string | undefined {
  const segments = path.split(/[\\/]+/u);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index];
    if (segment !== undefined && segment !== "") return segment;
  }
  return undefined;
}

/**
 * Parser-side file-name rule: bounded, no control characters, no separators
 * and no traversal segment. Deliberately looser than the store-path grammar
 * (leading/trailing dots and `..` inside a name are allowed here) -- identity
 * extraction must not editorialize beyond safety, while `encodeStorePath`
 * owns the storage-path policy.
 */
function debugFileNameProblem(name: string): string | undefined {
  if (name === "") return "it is empty";
  if ([...name].length > SEGMENT_MAX_LENGTH) {
    return `it is longer than ${SEGMENT_MAX_LENGTH} characters`;
  }
  if (name === "." || name === "..") return "it is a traversal segment";
  if (name.includes("/") || name.includes("\\")) return "it contains a path separator";
  if (controlCharacterIndex(name) !== -1) return "it contains a control character";
  return undefined;
}

/**
 * Formats a CodeView GUID + age the SymSrv way: Data1 (`uint32`), Data2 and
 * Data3 (`uint16`) are stored little-endian, so their textual components are
 * the byte-reversed first 8 bytes; Data4 stays in file order. Result is 32
 * uppercase hex characters followed by the age in uppercase hex without
 * leading zeros.
 */
function formatSymsrvDebugId(guid: Uint8Array, age: number): string {
  const view = toDataView(guid); // `guid` is 16 bytes by construction.
  let hex = (view.getUint32(0, true) >>> 0).toString(16).toUpperCase().padStart(8, "0");
  hex += view.getUint16(4, true).toString(16).toUpperCase().padStart(4, "0");
  hex += view.getUint16(6, true).toString(16).toUpperCase().padStart(4, "0");
  let rest = "";
  for (let index = 8; index < 16; index += 1) {
    rest += (guid[index] ?? 0).toString(16).toUpperCase().padStart(2, "0");
  }
  return hex + rest + (age >>> 0).toString(16).toUpperCase();
}

/**
 * Reads the RSDS record at the start of the PDB Info stream (stream 1) out of
 * the already-reassembled stream directory.
 */
function readRsdsIdentity(directory: Uint8Array, fileBytes: Uint8Array, blockSize: number): PdbIdentity {
  const view = toDataView(directory);
  const streamCount = readUint32(view, 0);
  if (streamCount === undefined) throw symbolIdentityUnreadable("stream directory is truncated");
  if (streamCount < 2) throw symbolIdentityUnreadable("PDB Info stream (stream 1) is missing");
  if (4 + streamCount * 4 > directory.length) throw symbolIdentityUnreadable("stream size table is truncated");
  const stream0Size = readUint32(view, 4);
  const stream1Size = readUint32(view, 8);
  if (stream0Size === undefined || stream1Size === undefined) {
    throw symbolIdentityUnreadable("stream size table is truncated");
  }
  if (stream1Size < RSDS_HEADER_BYTES + 1) {
    throw symbolIdentityUnreadable(`PDB Info stream is ${stream1Size} bytes; too small for an RSDS record`);
  }

  // MSF allocates a stream's blocks consecutively, so stream 1 starts right
  // after the blocks of stream 0 (zero-length streams consume no blocks).
  const stream1StartBlock = 1 + Math.ceil(stream0Size / blockSize);
  const scanBytes = Math.min(stream1Size, RSDS_PATH_SCAN_MAX);
  const prefix = readConsecutiveBlocks(fileBytes, blockSize, stream1StartBlock, scanBytes);
  if (prefix === undefined) throw symbolIdentityUnreadable("PDB Info stream is out of range");
  if (!matchesAscii(prefix, 0, RSDS_SIGNATURE)) {
    throw symbolIdentityUnreadable('PDB Info stream does not start with an "RSDS" record');
  }
  const guid = prefix.subarray(4, 20);
  const age = readUint32(toDataView(prefix), 20);
  if (age === undefined) throw symbolIdentityUnreadable("RSDS record header is truncated");
  const pathEnd = prefix.indexOf(0, RSDS_HEADER_BYTES);
  if (pathEnd === -1) {
    throw symbolIdentityUnreadable(`RSDS record path is not NUL-terminated within ${RSDS_PATH_SCAN_MAX} bytes`);
  }
  let path: string;
  try {
    path = UTF8_DECODER.decode(prefix.subarray(RSDS_HEADER_BYTES, pathEnd));
  } catch {
    throw symbolIdentityUnreadable("RSDS record path is not valid UTF-8");
  }
  const controlIndex = controlCharacterIndex(path);
  if (controlIndex !== -1) {
    throw symbolIdentityUnreadable(`RSDS record path contains a control character at index ${controlIndex}`);
  }
  const debugFile = fileNameFromPath(path);
  if (debugFile === undefined) throw symbolIdentityUnreadable("RSDS record path has no file name");
  const nameProblem = debugFileNameProblem(debugFile);
  if (nameProblem !== undefined) {
    throw symbolIdentityUnreadable(`RSDS record file name is unusable (${nameProblem})`);
  }
  return { debugFile, debugId: formatSymsrvDebugId(guid, age) };
}

/**
 * Parses a raw CodeView RSDS record, as found at a minidump module's CvRecord
 * location: 4-byte "RSDS" signature, 16-byte GUID, 4-byte little-endian age,
 * then a NUL-terminated UTF-8 PDB path. `debugFile` is the path's basename
 * (either separator style); `debugId` uses the same SymSrv formatting as
 * `parsePdbIdentity`.
 *
 * Strictly best-effort, unlike the MSF-container parser: non-RSDS signatures
 * (e.g. NB10 records), truncation, unterminated or unreadable paths, and
 * malformed fields all degrade to `undefined`, and the function never throws.
 * Linkage metadata must not fail an inspection, so callers can treat a
 * `undefined` result as "this module has no usable identity".
 */
export function parseRsdsCodeViewRecord(bytes: Uint8Array): PdbIdentity | undefined {
  if (!matchesAscii(bytes, 0, RSDS_SIGNATURE)) return undefined;
  // The smallest record is the 24-byte header plus a NUL terminator.
  if (bytes.length < RSDS_HEADER_BYTES + 1) return undefined;

  const age = readUint32(toDataView(bytes), 20);
  if (age === undefined) return undefined;
  const pathEnd = bytes.indexOf(0, RSDS_HEADER_BYTES);
  if (pathEnd === -1) return undefined;

  let path: string;
  try {
    path = UTF8_DECODER.decode(bytes.subarray(RSDS_HEADER_BYTES, pathEnd));
  } catch {
    return undefined;
  }
  if (controlCharacterIndex(path) !== -1) return undefined;
  const debugFile = fileNameFromPath(path);
  if (debugFile === undefined || debugFileNameProblem(debugFile) !== undefined) return undefined;

  return { debugFile, debugId: formatSymsrvDebugId(bytes.subarray(4, 20), age) };
}

/**
 * Derives the debug identity of a PDB from its bytes.
 *
 * Returns `undefined` when the bytes are not an MSF container. Throws
 * `DumpLedgerError("symbol_identity_unreadable")` when the MSF magic matches
 * (so the file claims to be a PDB) but no readable RSDS record can be
 * recovered from the PDB Info stream.
 */
export function parsePdbIdentity(bytes: Uint8Array): PdbIdentity | undefined {
  if (!looksLikeMsf(bytes)) return undefined;

  const view = toDataView(bytes);
  const blockSize = readUint32(view, MSF_BLOCK_SIZE_OFFSET);
  const numDirectoryBytes = readUint32(view, MSF_NUM_DIRECTORY_BYTES_OFFSET);
  const blockMapAddr = readUint32(view, MSF_BLOCK_MAP_ADDR_OFFSET);
  if (blockSize === undefined || numDirectoryBytes === undefined || blockMapAddr === undefined) {
    throw symbolIdentityUnreadable("superblock is truncated");
  }
  if (
    blockSize < MSF_MIN_BLOCK_SIZE ||
    blockSize > MSF_MAX_BLOCK_SIZE ||
    (blockSize & (blockSize - 1)) !== 0
  ) {
    throw symbolIdentityUnreadable(`block size ${blockSize} is not a supported power of two`);
  }
  if (blockSize > bytes.length) throw symbolIdentityUnreadable("block size exceeds the artifact size");
  if (numDirectoryBytes === 0) throw symbolIdentityUnreadable("stream directory is empty");
  if (numDirectoryBytes > bytes.length) {
    throw symbolIdentityUnreadable("stream directory is larger than the artifact");
  }

  // The block map starts at `blockMapAddr` and spans consecutive blocks; it
  // begins with one uint32 block index per stream-directory block.
  const directoryBlockCount = Math.ceil(numDirectoryBytes / blockSize);
  const blockMapBytes = directoryBlockCount * 4;
  const blockMap = readConsecutiveBlocks(bytes, blockSize, blockMapAddr, blockMapBytes);
  if (blockMap === undefined) throw symbolIdentityUnreadable("block map is out of range");

  const blockMapView = toDataView(blockMap);
  const directory = new Uint8Array(numDirectoryBytes);
  let copied = 0;
  for (let index = 0; index < directoryBlockCount && copied < numDirectoryBytes; index += 1) {
    const block = readUint32(blockMapView, index * 4);
    if (block === undefined) throw symbolIdentityUnreadable("block map is truncated");
    const took = copyBlockInto(bytes, blockSize, block, directory, copied, numDirectoryBytes - copied);
    if (took === undefined) throw symbolIdentityUnreadable("stream directory block is out of range");
    copied += took;
  }
  if (copied !== numDirectoryBytes) throw symbolIdentityUnreadable("stream directory is truncated");

  return readRsdsIdentity(directory, bytes, blockSize);
}

/**
 * Derives the code identity of a PE image from its bytes.
 *
 * `codeFile` is not derivable from the bytes (the COFF header stores no name),
 * so the caller supplies it; it must be a usable store-path segment.
 *
 * Returns `undefined` for anything that is not a PE image with a readable
 * COFF header and `SizeOfImage` field.
 */
export function parsePeIdentity(bytes: Uint8Array, codeFile: string): PeIdentity | undefined {
  const codeFileProblem = storeSegmentProblem(codeFile);
  if (codeFileProblem !== undefined) {
    throw invalidInput(`codeFile is not a usable store path segment (${codeFileProblem})`);
  }

  const view = toDataView(bytes);
  if (readUint16(view, 0) !== DOS_SIGNATURE) return undefined;
  if (bytes.length < DOS_E_LFANEW_OFFSET + 4) return undefined;
  const peOffset = readUint32(view, DOS_E_LFANEW_OFFSET);
  if (peOffset === undefined || peOffset > bytes.length - 4) return undefined;
  if (!matchesAscii(bytes, peOffset, PE_SIGNATURE)) return undefined;

  const coffOffset = peOffset + 4;
  if (coffOffset > bytes.length - COFF_HEADER_BYTES) return undefined;
  const timestamp = readUint32(view, coffOffset + COFF_TIMESTAMP_OFFSET);
  const sizeOfOptionalHeader = readUint16(view, coffOffset + COFF_OPTIONAL_HEADER_SIZE_OFFSET);
  if (timestamp === undefined || sizeOfOptionalHeader === undefined) return undefined;
  if (sizeOfOptionalHeader < OPTIONAL_HEADER_MIN_BYTES) return undefined;
  const sizeOfImage = readUint32(view, coffOffset + COFF_HEADER_BYTES + OPTIONAL_HEADER_SIZE_OF_IMAGE_OFFSET);
  if (sizeOfImage === undefined) return undefined;

  return { codeFile, codeId: formatPeCodeId(timestamp, sizeOfImage) };
}

/**
 * Formats `TimeDateStamp` + `SizeOfImage`: timestamp padded to 8 uppercase hex
 * digits (the minidump/Breakpad `%08X%x` convention), image size in uppercase
 * hex without leading zeros.
 */
function formatPeCodeId(timestamp: number, sizeOfImage: number): string {
  return (
    (timestamp >>> 0).toString(16).toUpperCase().padStart(8, "0") +
    (sizeOfImage >>> 0).toString(16).toUpperCase()
  );
}

/**
 * Store-path grammar (`GET /symbols/<name>/<id>/<file>`): exactly three
 * "/"-separated segments, each 1..255 characters without control characters,
 * backslashes, "..", or leading/trailing dots; the id segment must be 2..64
 * uppercase hex characters.
 *
 * `encodeStorePath` produces `<debugFile>/<debugId>/<debugFile>`;
 * `decodeStorePath` validates and returns the three segments -- it does not
 * require the first and third segment to match, so callers can serve `file`
 * and compare it with `debugFile` themselves.
 */
export function encodeStorePath(debugFile: string, debugId: string): string {
  const fileProblem = storeSegmentProblem(debugFile);
  if (fileProblem !== undefined) throw invalidInput(`debugFile is not a usable store path segment (${fileProblem})`);
  if (!DEBUG_ID_PATTERN.test(debugId)) {
    throw invalidInput("debugId must be 2..64 uppercase hex characters");
  }
  return `${debugFile}/${debugId}/${debugFile}`;
}

/** Splits and validates a store path; `undefined` for any malformed path. */
export function decodeStorePath(path: string): StorePathParts | undefined {
  const segments = path.split("/");
  if (segments.length !== 3) return undefined;
  const debugFile = segments[0];
  const debugId = segments[1];
  const file = segments[2];
  if (debugFile === undefined || debugId === undefined || file === undefined) return undefined;
  if (storeSegmentProblem(debugFile) !== undefined) return undefined;
  if (storeSegmentProblem(file) !== undefined) return undefined;
  if (!DEBUG_ID_PATTERN.test(debugId)) return undefined;
  return { debugFile, debugId, file };
}

/**
 * Storage-side segment rule: the store-path grammar above. Stricter than
 * `debugFileNameProblem` on purpose (no dots at the edges, no ".." anywhere),
 * because these segments become filesystem path components.
 */
function storeSegmentProblem(segment: string): string | undefined {
  if (segment === "") return "it is empty";
  if ([...segment].length > SEGMENT_MAX_LENGTH) {
    return `it is longer than ${SEGMENT_MAX_LENGTH} characters`;
  }
  if (segment.includes("/") || segment.includes("\\")) return "it contains a path separator";
  if (segment.includes("..")) return "it contains '..'";
  if (segment.startsWith(".") || segment.endsWith(".")) return "it starts or ends with '.'";
  if (controlCharacterIndex(segment) !== -1) return "it contains a control character";
  return undefined;
}
