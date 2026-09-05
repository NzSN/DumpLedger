const HEADER_SIZE = 32;
const DIRECTORY_ENTRY_SIZE = 12;

const STREAM_TYPE = {
  moduleList: 4,
  memoryList: 5,
  exception: 6,
  systemInfo: 7,
  memory64List: 9,
  memoryInfoList: 16,
} as const;

export interface SyntheticModule {
  readonly name: string;
  readonly baseOfImage?: bigint;
  readonly sizeOfImage?: number;
  readonly timestamp?: number;
}

export interface SyntheticMinidumpOptions {
  readonly flags?: bigint;
  readonly memoryListSizes?: readonly number[];
  readonly memory64ListSizes?: readonly number[];
  readonly includeMemoryInfoList?: boolean;
  readonly architecture?: number;
  readonly exception?: {
    readonly code: number;
    readonly address?: bigint;
  };
  readonly modules?: readonly SyntheticModule[];
}

interface StreamPlan {
  readonly type: number;
  readonly size: number;
  readonly build: (rva: number, allocate: (bytes: Buffer) => number) => Buffer;
}

export function syntheticMinidump(options: SyntheticMinidumpOptions = {}): Buffer {
  const plans: StreamPlan[] = [];

  if (options.memoryListSizes !== undefined) {
    const sizes = options.memoryListSizes;
    plans.push({
      type: STREAM_TYPE.memoryList,
      size: 4 + sizes.length * 16,
      build: (_rva, allocate) => {
        const stream = Buffer.alloc(4 + sizes.length * 16);
        stream.writeUInt32LE(sizes.length, 0);
        sizes.forEach((size, index) => {
          const descriptor = 4 + index * 16;
          stream.writeBigUInt64LE(0x1000n + BigInt(index) * 0x1000n, descriptor);
          stream.writeUInt32LE(size, descriptor + 8);
          stream.writeUInt32LE(allocate(Buffer.alloc(size, 0xa5)), descriptor + 12);
        });
        return stream;
      },
    });
  }

  if (options.memory64ListSizes !== undefined) {
    const sizes = options.memory64ListSizes;
    plans.push({
      type: STREAM_TYPE.memory64List,
      size: 16 + sizes.length * 16,
      build: (_rva, allocate) => {
        const stream = Buffer.alloc(16 + sizes.length * 16);
        stream.writeBigUInt64LE(BigInt(sizes.length), 0);
        const payload = Buffer.alloc(sizes.reduce((sum, size) => sum + size, 0), 0x5a);
        stream.writeBigUInt64LE(BigInt(allocate(payload)), 8);
        sizes.forEach((size, index) => {
          const descriptor = 16 + index * 16;
          stream.writeBigUInt64LE(0x100000n + BigInt(index) * 0x1000n, descriptor);
          stream.writeBigUInt64LE(BigInt(size), descriptor + 8);
        });
        return stream;
      },
    });
  }

  if (options.includeMemoryInfoList === true) {
    plans.push({
      type: STREAM_TYPE.memoryInfoList,
      size: 16,
      build: () => {
        const stream = Buffer.alloc(16);
        stream.writeUInt32LE(16, 0);
        stream.writeUInt32LE(48, 4);
        return stream;
      },
    });
  }

  if (options.architecture !== undefined) {
    plans.push({
      type: STREAM_TYPE.systemInfo,
      size: 56,
      build: () => {
        const stream = Buffer.alloc(56);
        stream.writeUInt16LE(options.architecture!, 0);
        return stream;
      },
    });
  }

  if (options.exception !== undefined) {
    plans.push({
      type: STREAM_TYPE.exception,
      size: 160,
      build: () => {
        const stream = Buffer.alloc(160);
        stream.writeUInt32LE(1, 0);
        stream.writeUInt32LE(options.exception!.code, 8);
        stream.writeBigUInt64LE(options.exception!.address ?? 0n, 24);
        return stream;
      },
    });
  }

  if (options.modules !== undefined) {
    const modules = options.modules;
    plans.push({
      type: STREAM_TYPE.moduleList,
      size: 4 + modules.length * 108,
      build: (_rva, allocate) => {
        const stream = Buffer.alloc(4 + modules.length * 108);
        stream.writeUInt32LE(modules.length, 0);
        modules.forEach((module, index) => {
          const descriptor = 4 + index * 108;
          stream.writeBigUInt64LE(module.baseOfImage ?? 0x140000000n, descriptor);
          stream.writeUInt32LE(module.sizeOfImage ?? 0x1000, descriptor + 8);
          stream.writeUInt32LE(module.timestamp ?? 0, descriptor + 16);
          const encodedName = Buffer.from(module.name, "utf16le");
          const minidumpString = Buffer.alloc(4 + encodedName.length);
          minidumpString.writeUInt32LE(encodedName.length, 0);
          encodedName.copy(minidumpString, 4);
          stream.writeUInt32LE(allocate(minidumpString), descriptor + 20);
        });
        return stream;
      },
    });
  }

  const streamRvas: number[] = [];
  let cursor = HEADER_SIZE + plans.length * DIRECTORY_ENTRY_SIZE;
  for (const plan of plans) {
    streamRvas.push(cursor);
    cursor += plan.size;
  }

  const payloads: Array<{ readonly rva: number; readonly bytes: Buffer }> = [];
  const allocate = (bytes: Buffer): number => {
    const rva = cursor;
    payloads.push({ rva, bytes });
    cursor += bytes.length;
    return rva;
  };

  const streamBytes = plans.map((plan, index) => plan.build(streamRvas[index]!, allocate));
  const dump = Buffer.alloc(cursor);
  dump.write("MDMP", 0, "ascii");
  dump.writeUInt32LE(0xa793, 4);
  dump.writeUInt32LE(plans.length, 8);
  dump.writeUInt32LE(HEADER_SIZE, 12);
  dump.writeBigUInt64LE(options.flags ?? 0n, 24);

  plans.forEach((plan, index) => {
    const directory = HEADER_SIZE + index * DIRECTORY_ENTRY_SIZE;
    dump.writeUInt32LE(plan.type, directory);
    dump.writeUInt32LE(plan.size, directory + 4);
    dump.writeUInt32LE(streamRvas[index]!, directory + 8);
    streamBytes[index]!.copy(dump, streamRvas[index]!);
  });
  payloads.forEach(({ rva, bytes }) => bytes.copy(dump, rva));
  return dump;
}

export function directoryOffset(index: number): number {
  return HEADER_SIZE + index * DIRECTORY_ENTRY_SIZE;
}
