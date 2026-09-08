import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createTarWriter,
  encodeTarSize,
  parseTarSize,
  readTar,
  type TarEntry,
  type TarSink,
  type TarSource,
  type TarWriter,
} from "../../src/transfer/tar.js";

const END_MARKER = new Uint8Array(1024);

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.byteLength; }
  return out;
}

function collector(): { sink: TarSink; bytes: () => Uint8Array } {
  const parts: Uint8Array[] = [];
  return { sink: { write(chunk) { parts.push(chunk); } }, bytes: () => concat(parts) };
}

function sourceOf(bytes: Uint8Array): TarSource {
  return {
    size: BigInt(bytes.byteLength),
    read(position, length) { return bytes.subarray(Number(position), Number(position) + length); },
  };
}

function writeEntry(writer: TarWriter, name: string, data: Uint8Array): void {
  const entry = writer.addEntry(name, BigInt(data.byteLength));
  for (let offset = 0; offset < data.byteLength; offset += 100) entry.append(data.subarray(offset, offset + 100));
  entry.finish();
}

function entryBytes(entry: TarEntry): Uint8Array {
  return concat([...entry.chunks()]);
}

function octal(block: Uint8Array, value: bigint, offset: number, length: number): void {
  const text = value.toString(8).padStart(length - 1, "0");
  for (let index = 0; index < length - 1; index += 1) block[offset + index] = text.charCodeAt(index);
}

/** Builds a raw ustar header so tests can craft archives the writer never would. */
function rawHeader(name: string, size: bigint, typeflag: number, linkname?: string): Uint8Array {
  const block = new Uint8Array(512);
  block.set(new TextEncoder().encode(name), 0);
  octal(block, 0o644n, 100, 8);
  octal(block, 0n, 108, 8);
  octal(block, 0n, 116, 8);
  octal(block, size, 124, 12);
  octal(block, 0n, 136, 12);
  block.fill(0x20, 148, 156);
  block[156] = typeflag;
  if (linkname !== undefined) block.set(new TextEncoder().encode(linkname), 157);
  block.set([0x75, 0x73, 0x74, 0x61, 0x72, 0x00, 0x30, 0x30], 257);
  let sum = 0;
  for (const byte of block) sum += byte;
  const text = sum.toString(8).padStart(6, "0");
  for (let index = 0; index < 6; index += 1) block[148 + index] = text.charCodeAt(index);
  block[154] = 0x00;
  block[155] = 0x20;
  return block;
}

function padded(data: Uint8Array): Uint8Array {
  const padding = (512 - (data.byteLength % 512)) % 512;
  return padding === 0 ? data : concat([data, new Uint8Array(padding)]);
}

function crafted(name: string, data: Uint8Array, typeflag = 0x30, linkname?: string): Uint8Array[] {
  return [rawHeader(name, BigInt(data.byteLength), typeflag, linkname), padded(data), END_MARKER];
}

function bytes(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (index * 31 + 7) & 0xff);
}

describe("tar writer/reader round trips", () => {
  it("round-trips multiple entries with byte-exact content", () => {
    const manifest = new TextEncoder().encode(JSON.stringify({ schema: "dump-ledger.export-manifest/v1" }));
    const ledger = bytes(700);
    const dump = bytes(4099);
    const { sink, bytes: archiveBytes } = collector();
    const writer = createTarWriter(sink);
    writeEntry(writer, "manifest.json", manifest);
    writeEntry(writer, "ledger.sqlite", ledger);
    writeEntry(writer, "vault/dump_01JTEST0000000000000000000/original.dmp", dump);
    writeEntry(writer, "empty.bin", new Uint8Array(0));
    writer.finish();
    const entries = [...readTar(sourceOf(archiveBytes()))];
    assert.deepEqual(entries.map(entry => entry.name), [
      "manifest.json",
      "ledger.sqlite",
      "vault/dump_01JTEST0000000000000000000/original.dmp",
      "empty.bin",
    ]);
    assert.deepEqual(entries.map(entry => entry.size), [BigInt(manifest.byteLength), 700n, 4099n, 0n]);
    assert.deepEqual(entryBytes(entries[0]!), manifest);
    assert.deepEqual(entryBytes(entries[1]!), ledger);
    assert.deepEqual(entryBytes(entries[2]!), dump);
    assert.deepEqual(entryBytes(entries[3]!), new Uint8Array(0));
  });

  it("produces identical archives for identical inputs", () => {
    const build = () => {
      const { sink, bytes: archiveBytes } = collector();
      const writer = createTarWriter(sink);
      writeEntry(writer, "a.bin", bytes(513));
      writeEntry(writer, "b.bin", bytes(1));
      writer.finish();
      return archiveBytes();
    };
    assert.deepEqual(build(), build());
  });
});

describe("tar size field codec", () => {
  it("encodes sizes below 8 GiB as zero-padded octal ASCII", () => {
    const field = encodeTarSize(8589934591n); // 8 GiB - 1, the largest octal-encodable size
    assert.equal(field.byteLength, 12);
    assert.equal(field[0]! & 0x80, 0);
    assert.equal(new TextDecoder().decode(field.subarray(0, 11)), "77777777777");
    assert.equal(field[11], 0);
    assert.equal(parseTarSize(field), 8589934591n);
    assert.equal(parseTarSize(encodeTarSize(0n)), 0n);
  });

  it("encodes sizes of at least 8 GiB as GNU base-256", () => {
    const size = 8589934592n; // exactly 8 GiB
    const field = encodeTarSize(size);
    assert.deepEqual([...field], [0x80, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0]);
    assert.equal(parseTarSize(field), size);
    const huge = 12345678901234567890n; // beyond 2^63, still exact through bigint
    assert.equal(parseTarSize(encodeTarSize(huge)), huge);
  });

  it("rejects negative sizes and sizes beyond the field capacity", () => {
    assert.throws(() => encodeTarSize(-1n), RangeError);
    assert.throws(() => encodeTarSize(1n << 88n), RangeError);
  });

  it("round-trips an 8 GiB header without writing the data", () => {
    const { sink, bytes: archiveBytes } = collector();
    createTarWriter(sink).addEntry("vault/dump_01JTEST0000000000000000000/original.dmp", 8n * 1024n ** 3n);
    const header = archiveBytes();
    assert.equal(header.byteLength, 512);
    const sparse: TarSource = {
      size: 512n + 8n * 1024n ** 3n + 1024n,
      read(position, length) {
        const out = new Uint8Array(length);
        const start = Number(position);
        if (start < 512) out.set(header.subarray(start, Math.min(512, start + length)));
        return out;
      },
    };
    const entries = [...readTar(sparse)];
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.name, "vault/dump_01JTEST0000000000000000000/original.dmp");
    assert.equal(entries[0]!.size, 8n * 1024n ** 3n);
  });
});

describe("tar reader strictness", () => {
  it("rejects absolute entry names", () => {
    const archive = concat(crafted("/etc/passwd", bytes(3)));
    assert.throws(() => [...readTar(sourceOf(archive))], /absolute/);
    const drive = concat(crafted("C:/evil.dmp", bytes(3)));
    assert.throws(() => [...readTar(sourceOf(drive))], /absolute/);
  });

  it("rejects '..' path components", () => {
    const escape = concat(crafted("../evil.dmp", bytes(3)));
    assert.throws(() => [...readTar(sourceOf(escape))], /\.\./);
    const nested = concat(crafted("vault/../evil.dmp", bytes(3)));
    assert.throws(() => [...readTar(sourceOf(nested))], /\.\./);
  });

  it("rejects non-regular-file typeflags", () => {
    for (const typeflag of [0x31, 0x32, 0x35, 0x78, 0x67]) { // hardlink, symlink, directory, pax x, pax g
      const archive = concat(crafted("entry", bytes(0), typeflag, typeflag === 0x32 ? "/etc/passwd" : undefined));
      assert.throws(() => [...readTar(sourceOf(archive))], /typeflag/);
    }
  });

  it("rejects duplicate entry names", () => {
    const archive = concat([...crafted("same.bin", bytes(4)).slice(0, 2), ...crafted("same.bin", bytes(4))]);
    assert.throws(() => [...readTar(sourceOf(archive))], /duplicate/);
  });

  it("rejects a bad header checksum", () => {
    const archive = concat(crafted("a.bin", bytes(4)));
    archive[101]! ^= 0xff; // flip a mode-field byte after the checksum was computed
    assert.throws(() => [...readTar(sourceOf(archive))], /checksum/);
  });

  it("rejects an archive truncated inside a header block", () => {
    const archive = concat(crafted("a.bin", bytes(4))).subarray(0, 200);
    assert.throws(() => [...readTar(sourceOf(archive))], /ends inside a header block/);
  });

  it("rejects an archive truncated inside entry data", () => {
    const header = rawHeader("a.bin", 1000n, 0x30);
    const archive = concat([header, bytes(512)]);
    assert.throws(() => [...readTar(sourceOf(archive))], /ends inside entry data/);
  });

  it("rejects an archive with no end-of-archive marker", () => {
    const archive = concat(crafted("a.bin", bytes(4)).slice(0, 2));
    assert.throws(() => [...readTar(sourceOf(archive))], /end-of-archive marker/);
  });

  it("enforces the entry count bound", () => {
    const archive = concat([...crafted("a.bin", bytes(1)).slice(0, 2), ...crafted("b.bin", bytes(1))]);
    assert.throws(() => [...readTar(sourceOf(archive), { maxEntries: 1 })], /entry count bound/);
    assert.equal([...readTar(sourceOf(archive), { maxEntries: 2 })].length, 2);
  });

  it("enforces the total byte bound", () => {
    const archive = concat([...crafted("a.bin", bytes(8)).slice(0, 2), ...crafted("b.bin", bytes(8))]);
    assert.throws(() => [...readTar(sourceOf(archive), { maxBytes: 10n })], /total byte bound/);
    assert.equal([...readTar(sourceOf(archive), { maxBytes: 16n })].length, 2);
  });

  it("enforces the name length bound", () => {
    const archive = concat(crafted("a".repeat(60), bytes(1)));
    assert.throws(() => [...readTar(sourceOf(archive), { maxNameLength: 20 })], /name length bound/);
    assert.equal([...readTar(sourceOf(archive), { maxNameLength: 60 })].length, 1);
  });
});

describe("tar writer strictness", () => {
  it("rejects names longer than 100 bytes of UTF-8", () => {
    const { sink } = collector();
    assert.throws(() => createTarWriter(sink).addEntry("a".repeat(101), 0n), /exceeds 100 bytes/);
    assert.throws(() => createTarWriter(sink).addEntry("é".repeat(51), 0n), /exceeds 100 bytes/); // 102 UTF-8 bytes
  });

  it("accepts a name of exactly 100 UTF-8 bytes", () => {
    const name = "é".repeat(50);
    const { sink, bytes: archiveBytes } = collector();
    const writer = createTarWriter(sink);
    writeEntry(writer, name, bytes(3));
    writer.finish();
    const entries = [...readTar(sourceOf(archiveBytes()))];
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.name, name);
  });

  it("rejects unsafe entry names before writing anything", () => {
    const { sink, bytes: archiveBytes } = collector();
    const writer = createTarWriter(sink);
    assert.throws(() => writer.addEntry("/absolute.dmp", 0n), /absolute/);
    assert.throws(() => writer.addEntry("vault/../escape.dmp", 0n), /\.\./);
    assert.throws(() => writer.addEntry("", 0n), /empty/);
    assert.equal(archiveBytes().byteLength, 0);
  });

  it("rejects entries that under- or over-fill their declared size", () => {
    const { sink } = collector();
    const under = createTarWriter(sink).addEntry("a.bin", 4n);
    under.append(bytes(3));
    assert.throws(() => under.finish(), /unwritten/);
    const over = createTarWriter(sink).addEntry("b.bin", 2n);
    assert.throws(() => over.append(bytes(3)), /more bytes than its declared size/);
  });

  it("rejects finishing with an entry still open", () => {
    const { sink } = collector();
    const writer = createTarWriter(sink);
    writer.addEntry("a.bin", 1n);
    assert.throws(() => writer.finish(), /still open/);
  });

  it("honours the injected clock for the mtime field", () => {
    const { sink, bytes: archiveBytes } = collector();
    const writer = createTarWriter(sink, { now: () => 1_700_000_000 });
    writeEntry(writer, "a.bin", bytes(1));
    writer.finish();
    const header = archiveBytes().subarray(0, 512);
    assert.equal(new TextDecoder().decode(header.subarray(136, 147)), (1_700_000_000).toString(8).padStart(11, "0"));
  });
});
