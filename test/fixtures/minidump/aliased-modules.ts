/** A sub-MiB file whose thousands of descriptors share one large field.
 * Aliasing is valid on disk but must not multiply the metadata budget. */
export function aliasedModules(field: "name" | "codeview", count = 4096): Buffer {
  const streamRva = 44;
  const fieldRva = streamRva + 4 + count * 108;
  const bytes = Buffer.alloc(fieldRva + 4 + 65_536);
  bytes.write("MDMP");
  bytes.writeUInt32LE(0xa793, 4);
  bytes.writeUInt32LE(1, 8);
  bytes.writeUInt32LE(32, 12);
  bytes.writeUInt32LE(4, 32);
  bytes.writeUInt32LE(4 + count * 108, 36);
  bytes.writeUInt32LE(streamRva, 40);
  bytes.writeUInt32LE(count, streamRva);
  for (let index = 0; index < count; index += 1) {
    const descriptor = streamRva + 4 + index * 108;
    if (field === "name") bytes.writeUInt32LE(fieldRva, descriptor + 20);
    else {
      bytes.writeUInt32LE(65_536, descriptor + 76);
      bytes.writeUInt32LE(fieldRva + 4, descriptor + 80);
    }
  }
  bytes.writeUInt32LE(65_536, fieldRva);
  // Control characters also exercise the worst-case JSON escape expansion.
  bytes.fill(Buffer.from("\u0001", "utf16le"), fieldRva + 4);
  return bytes;
}
