import { closeSync, fstatSync, openSync, readSync } from "node:fs";

/** A bounded, positional byte source. Implementations must not share a cursor. */
export interface RandomAccessSource {
  readonly size: bigint;
  readAt(offset: bigint, length: number): Buffer;
}

/** In-memory adapter intended for deterministic fixtures and callers with bytes already loaded. */
export class BufferRandomAccessSource implements RandomAccessSource {
  readonly size: bigint;

  constructor(private readonly bytes: Buffer) {
    this.size = BigInt(bytes.length);
  }

  readAt(offset: bigint, length: number): Buffer {
    if (offset < 0n || offset > BigInt(Number.MAX_SAFE_INTEGER)) return Buffer.alloc(0);
    const start = Number(offset);
    return Buffer.from(this.bytes.subarray(start, start + length));
  }
}

/** File-backed adapter for production inspection. The caller owns its lifetime. */
export class FileRandomAccessSource implements RandomAccessSource {
  readonly size: bigint;
  private closed = false;

  private constructor(private readonly descriptor: number) {
    this.size = fstatSync(descriptor, { bigint: true }).size;
  }

  static open(path: string): FileRandomAccessSource {
    const descriptor = openSync(path, "r");
    try {
      return new FileRandomAccessSource(descriptor);
    } catch (error: unknown) {
      closeSync(descriptor);
      throw error;
    }
  }

  readAt(offset: bigint, length: number): Buffer {
    if (this.closed) throw new Error("random-access source is closed");
    const bytes = Buffer.alloc(length);
    const read = readSync(this.descriptor, bytes, 0, length, offset);
    return read === length ? bytes : bytes.subarray(0, read);
  }

  close(): void {
    if (!this.closed) {
      closeSync(this.descriptor);
      this.closed = true;
    }
  }
}
