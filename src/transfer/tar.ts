import { DumpLedgerError } from "../domain/errors.js";

/**
 * Streaming ustar tar writer and strict tar reader for export bundles.
 *
 * Writer: regular files only, declared sizes up front, bytes forwarded to the
 * sink as they arrive (no whole-file buffering), deterministic headers (fixed
 * uid/gid/mode, mtime from an injected clock defaulting to 0).
 *
 * Reader: position-based pull source, lazy per-entry chunk iteration, strict
 * structural validation (checksum, magic, typeflag, path safety, duplicates,
 * bounds, truncation). Sizes are bigint end to end; sizes >= 8 GiB use the
 * GNU base-256 binary encoding, smaller sizes use octal ASCII.
 */

const BLOCK_SIZE = 512;
const HEADER_NAME_BYTES = 100;
const ENTRY_CHUNK_SIZE = 256 * 1024;
const END_MARKER_BLOCKS = 2;
const OCTAL_SIZE_LIMIT = 0o77777777777n; // 8 GiB - 1: largest value in 11 octal digits
const BASE256_SIZE_LIMIT = 1n << 88n; // magnitude capacity of the 11-byte big-endian field
const DEFAULT_MODE = 0o644;
const DEFAULT_MAX_ENTRIES = 1_000_000;
const DEFAULT_MAX_BYTES = BigInt(Number.MAX_SAFE_INTEGER);
const USTAR_MAGIC = [0x75, 0x73, 0x74, 0x61, 0x72, 0x00, 0x30, 0x30] as const; // "ustar\0" + "00"
const TYPEFLAG_REGULAR = 0x30; // '0'

export interface TarSink {
  write(bytes: Uint8Array): void;
}

/** Structurally compatible with VaultReader (minus close), so vault readers adapt directly. */
export interface TarSource {
  readonly size: bigint;
  read(position: bigint, length: number): Uint8Array;
}

export interface TarWriterOptions {
  /** Clock returning seconds since the epoch for the mtime field; defaults to a fixed 0. */
  readonly now?: () => number;
  /** Fixed mode field written for every entry; defaults to 0o644. */
  readonly mode?: number;
}

export interface TarEntryWriter {
  append(chunk: Uint8Array): void;
  finish(): void;
}

export interface TarWriter {
  addEntry(name: string, size: bigint): TarEntryWriter;
  finish(): void;
}

export interface TarReaderOptions {
  readonly maxEntries?: number;
  readonly maxBytes?: bigint;
  readonly maxNameLength?: number;
}

export interface TarEntry {
  readonly name: string;
  readonly size: bigint;
  chunks(): Generator<Uint8Array, void, undefined>;
}

function invalid(message: string): DumpLedgerError {
  return new DumpLedgerError("invalid_input", message);
}

function corrupt(message: string): DumpLedgerError {
  return new DumpLedgerError("integrity_failure", message);
}

/** Encodes a tar size field: octal ASCII below 8 GiB, GNU base-256 at or above it. */
export function encodeTarSize(size: bigint): Uint8Array {
  if (size < 0n) throw new RangeError("tar entry size cannot be negative");
  const field = new Uint8Array(12);
  if (size <= OCTAL_SIZE_LIMIT) {
    const digits = size.toString(8).padStart(11, "0");
    for (let index = 0; index < 11; index += 1) field[index] = digits.charCodeAt(index);
    return field;
  }
  if (size >= BASE256_SIZE_LIMIT) throw new RangeError("tar entry size exceeds the base-256 field capacity");
  field[0] = 0x80;
  let value = size;
  for (let index = 11; index >= 1; index -= 1) {
    field[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  return field;
}

/** Decodes a tar size field, accepting both octal ASCII and GNU base-256. */
export function parseTarSize(field: Uint8Array): bigint {
  if (field.length !== 12) throw invalid("tar size field must be exactly 12 bytes");
  const first = field[0]!;
  if ((first & 0x80) !== 0) {
    if ((first & 0x7f) !== 0) throw invalid("tar size uses an unsupported base-256 encoding");
    let value = 0n;
    for (let index = 1; index < 12; index += 1) value = (value << 8n) | BigInt(field[index]!);
    return value;
  }
  return parseOctalField(field, "size");
}

function parseOctalField(field: Uint8Array, label: string): bigint {
  let value = 0n;
  let digits = 0;
  let terminated = false;
  for (const byte of field) {
    if (!terminated && byte >= 0x30 && byte <= 0x37) {
      value = value * 8n + BigInt(byte - 0x30);
      digits += 1;
    } else if (byte === 0x00 || byte === 0x20) {
      terminated = true;
    } else {
      throw invalid(`malformed octal ${label} field in tar header`);
    }
  }
  if (digits === 0) throw invalid(`empty ${label} field in tar header`);
  return value;
}

function writeOctalField(block: Uint8Array, offset: number, length: number, value: bigint, label: string): void {
  const digits = value.toString(8);
  if (value < 0n || digits.length > length - 1) throw new RangeError(`${label} does not fit in a ${length}-byte tar field: ${value}`);
  const text = digits.padStart(length - 1, "0");
  for (let index = 0; index < length - 1; index += 1) block[offset + index] = text.charCodeAt(index);
  block[offset + length - 1] = 0;
}

function checkEntryName(name: string): void {
  if (name.length === 0) throw invalid("tar entry name is empty");
  if (name.includes("\0")) throw invalid(`tar entry name contains a NUL byte: ${name}`);
  if (name.includes("\\")) throw invalid(`tar entry name contains a backslash: ${name}`);
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) throw invalid(`tar entry name is absolute: ${name}`);
  for (const component of name.split("/")) {
    if (component.length === 0) throw invalid(`tar entry name has an empty path component: ${name}`);
    if (component === "..") throw invalid(`tar entry name contains a '..' path component: ${name}`);
  }
}

function encodeHeaderBlock(name: string, size: bigint, mtime: number, mode: number): Uint8Array {
  const block = new Uint8Array(BLOCK_SIZE);
  block.set(new TextEncoder().encode(name), 0);
  writeOctalField(block, 100, 8, BigInt(mode), "mode");
  writeOctalField(block, 108, 8, 0n, "uid");
  writeOctalField(block, 116, 8, 0n, "gid");
  block.set(encodeTarSize(size), 124);
  writeOctalField(block, 136, 12, BigInt(mtime), "mtime");
  block.fill(0x20, 148, 156); // checksum field reads as spaces while summing
  block[156] = TYPEFLAG_REGULAR;
  block.set(USTAR_MAGIC, 257);
  let sum = 0;
  for (const byte of block) sum += byte;
  const text = sum.toString(8).padStart(6, "0");
  for (let index = 0; index < 6; index += 1) block[148 + index] = text.charCodeAt(index);
  block[154] = 0x00;
  block[155] = 0x20;
  return block;
}

export function createTarWriter(sink: TarSink, options: TarWriterOptions = {}): TarWriter {
  const now = options.now ?? (() => 0);
  const mode = options.mode ?? DEFAULT_MODE;
  if (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o7777) throw new RangeError("tar entry mode must be an integer between 0 and 0o7777");
  let openEntry: { readonly name: string; readonly size: bigint; remaining: bigint; finished: boolean } | null = null;
  let sealed = false;
  return {
    addEntry(name: string, size: bigint): TarEntryWriter {
      if (sealed) throw new DumpLedgerError("invalid_transition", "tar writer is already finished");
      if (openEntry !== null && !openEntry.finished) throw new DumpLedgerError("invalid_transition", `tar entry is still open: ${openEntry.name}`);
      if (typeof size !== "bigint" || size < 0n) throw new RangeError("tar entry size must be a non-negative bigint");
      checkEntryName(name);
      const nameBytes = new TextEncoder().encode(name);
      if (nameBytes.byteLength > HEADER_NAME_BYTES) throw invalid(`tar entry name exceeds ${HEADER_NAME_BYTES} bytes of UTF-8: ${name}`);
      const mtime = now();
      if (!Number.isSafeInteger(mtime) || mtime < 0 || BigInt(mtime) > OCTAL_SIZE_LIMIT) throw new RangeError("tar clock must return seconds since the epoch that fit the mtime field");
      sink.write(encodeHeaderBlock(name, size, mtime, mode));
      const state = { name, size, remaining: size, finished: false };
      openEntry = state;
      return {
        append(chunk: Uint8Array): void {
          if (state.finished) throw new DumpLedgerError("invalid_transition", `tar entry is already finished: ${name}`);
          if (BigInt(chunk.byteLength) > state.remaining) throw invalid(`tar entry received more bytes than its declared size: ${name}`);
          sink.write(chunk);
          state.remaining -= BigInt(chunk.byteLength);
        },
        finish(): void {
          if (state.finished) throw new DumpLedgerError("invalid_transition", `tar entry is already finished: ${name}`);
          if (state.remaining !== 0n) throw invalid(`tar entry closed with ${state.remaining} of ${state.size} bytes unwritten: ${name}`);
          const padding = Number((BigInt(BLOCK_SIZE) - (state.size % BigInt(BLOCK_SIZE))) % BigInt(BLOCK_SIZE));
          if (padding > 0) sink.write(new Uint8Array(padding));
          state.finished = true;
        },
      };
    },
    finish(): void {
      if (sealed) throw new DumpLedgerError("invalid_transition", "tar writer is already finished");
      if (openEntry !== null && !openEntry.finished) throw new DumpLedgerError("invalid_transition", `tar entry is still open: ${openEntry.name}`);
      sink.write(new Uint8Array(BLOCK_SIZE * END_MARKER_BLOCKS));
      sealed = true;
    },
  };
}

function isZeroBlock(block: Uint8Array): boolean {
  for (const byte of block) if (byte !== 0) return false;
  return true;
}

function readBlock(source: TarSource, offset: bigint): Uint8Array | null {
  if (source.size - offset < BigInt(BLOCK_SIZE)) return null;
  const block = source.read(offset, BLOCK_SIZE);
  return block.byteLength === BLOCK_SIZE ? block : null;
}

function verifyChecksum(block: Uint8Array): void {
  const field = block.subarray(148, 156);
  let stored = 0;
  for (let index = 0; index < 6; index += 1) {
    const byte = field[index]!;
    if (byte < 0x30 || byte > 0x37) throw invalid("malformed tar header checksum field");
    stored = stored * 8 + (byte - 0x30);
  }
  if (field[6] !== 0x00 || field[7] !== 0x20) throw invalid("malformed tar header checksum field");
  let sum = 0;
  for (let index = 0; index < BLOCK_SIZE; index += 1) sum += index >= 148 && index < 156 ? 0x20 : block[index]!;
  if (sum !== stored) throw corrupt("tar header checksum mismatch");
}

function parseHeaderBlock(block: Uint8Array, maxNameLength: number): { name: string; size: bigint } {
  verifyChecksum(block);
  for (let index = 0; index < USTAR_MAGIC.length; index += 1) {
    if (block[257 + index] !== USTAR_MAGIC[index]) throw invalid("tar header is not a POSIX ustar header");
  }
  const typeflag = block[156]!;
  if (typeflag !== TYPEFLAG_REGULAR && typeflag !== 0x00) {
    throw invalid(`tar entry has unsupported typeflag ${JSON.stringify(String.fromCharCode(typeflag))}: only regular files are allowed`);
  }
  for (let index = 157; index < 257; index += 1) if (block[index] !== 0) throw invalid("tar header carries a link name");
  for (let index = 329; index < 500; index += 1) if (block[index] !== 0) throw invalid("tar header carries device or prefix fields, which are unsupported");
  let nameEnd = 0;
  while (nameEnd < HEADER_NAME_BYTES && block[nameEnd] !== 0) nameEnd += 1;
  for (let index = nameEnd; index < HEADER_NAME_BYTES; index += 1) if (block[index] !== 0) throw invalid("tar entry name has data after its terminator");
  const nameBytes = block.subarray(0, nameEnd);
  if (nameBytes.byteLength > maxNameLength) throw invalid(`tar entry name exceeds the name length bound of ${maxNameLength} bytes`);
  let name: string;
  try {
    name = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes);
  } catch {
    throw invalid("tar entry name is not valid UTF-8");
  }
  checkEntryName(name);
  parseOctalField(block.subarray(100, 108), "mode");
  parseOctalField(block.subarray(108, 116), "uid");
  parseOctalField(block.subarray(116, 124), "gid");
  parseOctalField(block.subarray(136, 148), "mtime");
  return { name, size: parseTarSize(block.subarray(124, 136)) };
}

function* entryChunks(source: TarSource, dataOffset: bigint, size: bigint): Generator<Uint8Array, void, undefined> {
  let position = dataOffset;
  let remaining = size;
  while (remaining > 0n) {
    const wanted = remaining < BigInt(ENTRY_CHUNK_SIZE) ? Number(remaining) : ENTRY_CHUNK_SIZE;
    const chunk = source.read(position, wanted);
    if (chunk.byteLength !== wanted) throw corrupt("tar archive ends inside entry data");
    yield chunk;
    position += BigInt(wanted);
    remaining -= BigInt(wanted);
  }
}

function* iterateTar(source: TarSource, maxEntries: number, maxBytes: bigint, maxNameLength: number): Generator<TarEntry, void, undefined> {
  const seen = new Set<string>();
  let offset = 0n;
  let entries = 0;
  let totalBytes = 0n;
  let ended = false;
  while (true) {
    if (offset === source.size) break;
    const block = readBlock(source, offset);
    if (block === null) throw corrupt("tar archive ends inside a header block");
    offset += BigInt(BLOCK_SIZE);
    if (isZeroBlock(block)) {
      ended = true;
      break;
    }
    const { name, size } = parseHeaderBlock(block, maxNameLength);
    entries += 1;
    if (entries > maxEntries) throw invalid(`tar archive exceeds the entry count bound of ${maxEntries}`);
    totalBytes += size;
    if (totalBytes > maxBytes) throw invalid(`tar archive exceeds the total byte bound of ${maxBytes}`);
    const dataOffset = offset;
    const paddedEnd = dataOffset + size + ((BigInt(BLOCK_SIZE) - (size % BigInt(BLOCK_SIZE))) % BigInt(BLOCK_SIZE));
    if (paddedEnd > source.size) throw corrupt("tar archive ends inside entry data");
    if (seen.has(name)) throw invalid(`duplicate tar entry name: ${name}`);
    seen.add(name);
    yield { name, size, chunks: () => entryChunks(source, dataOffset, size) };
    offset = paddedEnd;
  }
  if (!ended) throw corrupt("tar archive has no end-of-archive marker");
  while (offset < source.size) {
    const block = readBlock(source, offset);
    if (block === null || !isZeroBlock(block)) throw invalid("tar archive carries data after its end-of-archive marker");
    offset += BigInt(BLOCK_SIZE);
  }
}

/**
 * Iterates the entries of a strict ustar archive. The archive is validated as
 * iteration proceeds; exhausting the iterator also validates the trailer.
 * Entry data is read lazily through entry.chunks(), so large entries never
 * need to be buffered.
 */
export function readTar(source: TarSource, options: TarReaderOptions = {}): Generator<TarEntry, void, undefined> {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxNameLength = options.maxNameLength ?? HEADER_NAME_BYTES;
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 0) throw new RangeError("maxEntries must be a non-negative safe integer");
  if (maxBytes < 0n) throw new RangeError("maxBytes must be a non-negative bigint");
  if (!Number.isSafeInteger(maxNameLength) || maxNameLength < 1 || maxNameLength > HEADER_NAME_BYTES) throw new RangeError(`maxNameLength must be an integer between 1 and ${HEADER_NAME_BYTES}`);
  return iterateTar(source, maxEntries, maxBytes, maxNameLength);
}
