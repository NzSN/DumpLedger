import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { CSRF_HEADER, decodeCreateExportResponse, decodeErrorResponse, decodeListExportsResponse, type ExportSummary } from "@dump-ledger/http-contracts";
import { OperatorSessions, hashOperatorPassword } from "../../src/auth/sessions.js";
import type { DumpId, GrantId, SymbolArtifactId } from "../../src/domain/ids.js";
import { RandomIds } from "../../src/engine/dependencies.js";
import {
  createDumpLedgerEngine,
  DeterministicClock,
  DeterministicEntropy,
  type DumpLedgerEngine,
} from "../../src/engine/dump-ledger-engine.js";
import type { InspectionOutcome, InspectionPort } from "../../src/engine/inspection-port.js";
import type { DumpLedgerProjection, TransitionReceipt, TransitionSuccess } from "../../src/engine/projection.js";
import { EngineHttpApplication } from "../../src/http/application.js";
import { buildHttpServer, type HttpServerOptions } from "../../src/http/server.js";
import { EngineUploadLifecycle, EngineUploadPostProcessor, VaultUploadSink } from "../../src/intake/intake-facade.js";
import { parsePdbIdentity, type PdbIdentity } from "../../src/symbols/identity.js";
import { exportBundle } from "../../src/transfer/export.js";
import { importBundle, type ImportOutcome } from "../../src/transfer/import.js";
import { dumpEntryName, parseExportManifest, symbolEntryName, type ExportManifest } from "../../src/transfer/manifest.js";
import { TransferManager } from "../../src/transfer/manager.js";
import { readTar, type TarSource } from "../../src/transfer/tar.js";
import { FilesystemVault } from "../../src/vault/filesystem-vault.js";
import { MemoryVault } from "../../src/vault/memory-vault.js";

/**
 * Integration coverage for the opt-in symbol payload (design milestone 3):
 * export with `includeSymbols` carries one entry per registered artifact the
 * declared dumps' stored facts reference; import re-verifies and re-ingests
 * them through the engine; the flag omitted is byte-identical to the
 * pre-flag pipeline. The inspection seam is stubbed (the parallel worker's
 * inspection-facts field names are pinned: modules[].debugFile/debugId), so
 * this suite never parses a real minidump.
 */

const T0 = "2026-09-04T00:00:00.000Z";
const T1 = "2026-10-04T00:00:00.000Z";
const GRANT_KEY = Uint8Array.from({ length: 32 }, () => 0x41);
const SECRETS = ["symbols-secret-00000000000000000001", "symbols-secret-00000000000000000002"];

function show(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (typeof item === "bigint" ? item.toString() : item));
}

function must(receipt: TransitionReceipt): TransitionSuccess {
  assert.ok(receipt.ok, show(receipt));
  return receipt;
}

function sha256hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/* ---------------- synthetic PDB (identity parseable) ---------------- */

const MSF_MAGIC = "Microsoft C/C++ MSF 7.00\r\n\u001aDS";
const BLOCK_SIZE = 4096;

/** Minimal MSF 7.0 container (one tiny stream plus the PDB Info stream). */
function syntheticPdb(pdbPath: string, guid: Buffer, age: number): Buffer {
  // The real PDB Info stream header: version, signature, age, GUID (no path).
  const header = Buffer.alloc(4 + 4 + 4 + 16);
  header.writeUInt32LE(20140508, 0); // PdbImpV VC140
  header.writeUInt32LE(0x5dc5d9be, 4);
  header.writeUInt32LE(age >>> 0, 8);
  guid.copy(header, 12);
  const streams = [Buffer.from([0x01, 0x02, 0x03, 0x04, 0x00, 0x00, 0x00, 0x00]), header];

  const streamStartBlocks: number[] = [];
  let nextBlock = 1;
  for (const stream of streams) {
    streamStartBlocks.push(nextBlock);
    nextBlock += Math.ceil(stream.length / BLOCK_SIZE);
  }
  // MSF 7.0 directory: stream count, the size table, then one uint32 block
  // list per stream (real MSF does not guarantee consecutive stream layout).
  const streamBlockCounts = streams.map((stream) => Math.ceil(stream.length / BLOCK_SIZE));
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
  const directoryStartBlock = nextBlock;
  const directoryBlockCount = Math.ceil(directory.length / BLOCK_SIZE);
  nextBlock += directoryBlockCount;
  let blockMapBlockCount = Math.ceil((directoryBlockCount * 4) / BLOCK_SIZE);
  while ((directoryBlockCount + blockMapBlockCount) * 4 > blockMapBlockCount * BLOCK_SIZE) blockMapBlockCount += 1;
  const blockMapStartBlock = nextBlock;
  nextBlock += blockMapBlockCount;

  const bytes = Buffer.alloc(nextBlock * BLOCK_SIZE);
  bytes.write(MSF_MAGIC, 0, "latin1");
  bytes.writeUInt32LE(BLOCK_SIZE, 32);
  bytes.writeUInt32LE(1, 36);
  bytes.writeUInt32LE(nextBlock, 40);
  bytes.writeUInt32LE(directory.length, 44);
  bytes.writeUInt32LE(0, 48);
  bytes.writeUInt32LE(blockMapStartBlock, 52);
  streams.forEach((stream, index) => stream.copy(bytes, streamStartBlocks[index]! * BLOCK_SIZE));
  directory.copy(bytes, directoryStartBlock * BLOCK_SIZE);
  const mapOffset = blockMapStartBlock * BLOCK_SIZE;
  for (let index = 0; index < directoryBlockCount; index += 1) bytes.writeUInt32LE(directoryStartBlock + index, mapOffset + index * 4);
  for (let index = 0; index < blockMapBlockCount; index += 1) bytes.writeUInt32LE(blockMapStartBlock + index, mapOffset + (directoryBlockCount + index) * 4);
  return bytes;
}

/**
 * Canonical GUID 01234567-89AB-CDEF-0123-456789ABCDEF in PDB byte order:
 * Data1/Data2/Data3 little-endian, Data4 in order.
 */
function pdbGuid(): Buffer {
  const guid = Buffer.alloc(16);
  guid.writeUInt32LE(0x01234567, 0);
  guid.writeUInt16LE(0x89ab, 4);
  guid.writeUInt16LE(0xcdef, 6);
  Buffer.from([0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]).copy(guid, 8);
  return guid;
}

/* ---------------- stubbed inspection seam ---------------- */

class ScriptedInspection implements InspectionPort {
  facts: Readonly<Record<string, unknown>> = { source: "transfer-symbols-test" };

  inspect(_dumpId: DumpId): InspectionOutcome {
    return { ok: true, coverage: "partial", facts: this.facts };
  }
}

interface Instance {
  readonly root: string;
  readonly engine: DumpLedgerEngine;
  readonly vault: FilesystemVault;
  readonly inspection: ScriptedInspection;
}

function makeInstance(root: string): Instance {
  mkdirSync(root, { recursive: true });
  const vault = new FilesystemVault(join(root, "vault"));
  const inspection = new ScriptedInspection();
  const engine = createDumpLedgerEngine({
    databasePath: join(root, "ledger.sqlite"),
    vault,
    inspection,
    grantSecretKey: GRANT_KEY,
    clock: new DeterministicClock(T0),
    entropy: new DeterministicEntropy([...SECRETS]),
    ids: new RandomIds(),
  });
  return { root, engine, vault, inspection };
}

/** Registers one artifact through the engine's symbol commands (the same path the operator route uses). */
function seedSymbol(instance: Instance, bytes: Uint8Array, identity: PdbIdentity): SymbolArtifactId {
  const begun = must(instance.engine.execute({ type: "IngestSymbol", kind: "pdb" }));
  const artifactId = begun.artifactId;
  assert.ok(artifactId !== undefined);
  instance.vault.appendSymbol(artifactId, bytes);
  instance.vault.syncAndCloseSymbol(artifactId);
  must(instance.engine.execute({
    type: "SealSymbol",
    artifactId,
    debugFile: identity.debugFile,
    debugId: identity.debugId,
    kind: "pdb",
    byteSize: BigInt(bytes.byteLength),
    sha256: sha256hex(bytes),
    product: "Electron",
    version: "41.10.6",
    arch: "x64",
  }));
  return artifactId;
}

interface Populated {
  readonly dumpId: DumpId;
  readonly dumpBytes: Buffer;
  readonly grantId: GrantId;
  readonly artifactId: SymbolArtifactId;
  readonly identity: PdbIdentity;
  readonly snapshot: DumpLedgerProjection;
}

/**
 * One customer/case/grant, one registered symbol artifact, and one accepted
 * dump whose stored facts reference that artifact's exact identity.
 */
function populate(instance: Instance, symbolBytes: Buffer, identity: PdbIdentity): Populated {
  const artifactId = seedSymbol(instance, symbolBytes, identity);
  instance.inspection.facts = {
    source: "transfer-symbols-test",
    modules: [
      { name: "electron.exe", baseOfImage: "140000000", sizeOfImage: 1, timestamp: 1, debugFile: identity.debugFile, debugId: identity.debugId },
      { name: "unmatched.dll", baseOfImage: "180000000", sizeOfImage: 1, timestamp: 2, debugFile: "other.pdb", debugId: "FFFFFFFF" },
    ],
  };
  const customer = must(instance.engine.execute({ type: "CreateCustomer", displayName: "Acme" })).customerId!;
  const caseId = must(instance.engine.execute({ type: "CreateCase", customerId: customer, title: "Symbol round trip" })).caseId!;
  const grant = must(instance.engine.execute({ type: "IssueGrant", caseId, expiresAt: T1, maxBytes: 16n * 1024n * 1024n }));
  const dumpBytes = Buffer.from("transfer-symbols dump payload");
  const begun = must(instance.engine.execute({ type: "BeginUpload", grantSecret: grant.grantSecret!, originalName: "crash.dmp" }));
  const dumpId = begun.dumpId!;
  instance.vault.append(dumpId, dumpBytes);
  instance.vault.syncAndClose(dumpId);
  must(instance.engine.execute({ type: "SealUpload", dumpId, byteSize: BigInt(dumpBytes.byteLength), sha256: sha256hex(dumpBytes) }));
  must(instance.engine.execute({ type: "PromoteObject", dumpId }));
  must(instance.engine.execute({ type: "MarkQuarantined", dumpId }));
  must(instance.engine.execute({ type: "AcceptDump", dumpId }));
  return { dumpId, dumpBytes, grantId: grant.grantId!, artifactId, identity, snapshot: instance.engine.snapshot() };
}

function bufferSource(bytes: Uint8Array): TarSource {
  return { size: BigInt(bytes.byteLength), read: (position, length) => bytes.slice(Number(position), Number(position) + length) };
}

function entryNames(bytes: Uint8Array): string[] {
  return [...readTar(bufferSource(bytes))].map(entry => entry.name);
}

function entryBytes(bytes: Uint8Array, name: string): Uint8Array {
  const entry = [...readTar(bufferSource(bytes))].find(candidate => candidate.name === name);
  assert.ok(entry !== undefined, `tar entry not found: ${name}`);
  const chunks = [...entry.chunks()];
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function manifestOf(bundlePath: string): ExportManifest {
  return parseExportManifest(entryBytes(readFileSync(bundlePath), "manifest.json"));
}

/** Byte offset of one entry's data block (used to tamper the symbol payload). */
function entryDataOffset(bytes: Buffer, name: string): number {
  let offset = 0;
  for (const entry of readTar(bufferSource(bytes))) {
    const dataOffset = offset + 512;
    if (entry.name === name) return dataOffset;
    const size = Number(entry.size);
    offset = dataOffset + size + ((512 - (size % 512)) % 512);
  }
  throw new Error(`tar entry not found: ${name}`);
}

function comparable(snapshot: DumpLedgerProjection): unknown {
  return { customers: snapshot.customers, cases: snapshot.cases, grants: snapshot.grants, dumps: snapshot.dumps, downloadable: snapshot.downloadable };
}

async function exportTo(instance: Instance, exportsDir: string, includeSymbols?: boolean): Promise<{ readonly bundlePath: string; readonly summary: ExportSummary }> {
  const summary = await exportBundle({
    engine: instance.engine,
    vault: instance.vault,
    exportsDir,
    ...(includeSymbols === undefined ? {} : { includeSymbols }),
  });
  assert.equal(summary.status, "sealed", show(summary));
  return { bundlePath: join(exportsDir, summary.exportId, "bundle.tar"), summary };
}

describe("transfer bundles with symbols", () => {
  it("carries one matched artifact and re-ingests it on a fresh instance while the dump imports identically", async () => {
    const root = mkdtempSync(join(tmpdir(), "dump-ledger-symbols-"));
    try {
      const a = makeInstance(join(root, "a"));
      const symbolBytes = syntheticPdb("C:\\build\\out\\electron.pdb", pdbGuid(), 7);
      const identity = parsePdbIdentity(symbolBytes, "electron.pdb");
      assert.ok(identity !== undefined);
      const populated = populate(a, symbolBytes, identity);

      const { bundlePath } = await exportTo(a, join(root, "a-exports"), true);
      const bundleBytes = readFileSync(bundlePath);
      // manifest first; symbols stream after the dump entries, one entry per identity
      assert.deepEqual(entryNames(bundleBytes), ["manifest.json", "ledger.sqlite", dumpEntryName(populated.dumpId), symbolEntryName(populated.artifactId)]);
      const manifest = manifestOf(bundlePath);
      assert.equal(manifest.counts.symbols, 1);
      assert.deepEqual(manifest.symbols?.map(entry => entry.artifactId), [populated.artifactId]);
      assert.equal(manifest.symbols?.[0]?.debugFile, identity.debugFile);
      assert.equal(manifest.symbols?.[0]?.debugId, identity.debugId);
      assert.equal(manifest.symbols?.[0]?.kind, "pdb");
      assert.equal(manifest.symbols?.[0]?.byteSize, BigInt(symbolBytes.byteLength));
      assert.equal(manifest.symbols?.[0]?.sha256, sha256hex(symbolBytes));
      assert.equal(manifest.symbols?.[0]?.product, "Electron");
      assert.deepEqual(Buffer.from(entryBytes(bundleBytes, symbolEntryName(populated.artifactId))), symbolBytes);

      const b = makeInstance(join(root, "b"));
      // the restored instance re-inspects the imported bytes; the stubbed seam
      // must report the same facts the source recorded
      b.inspection.facts = a.inspection.facts;
      const outcome: ImportOutcome = importBundle({ engine: b.engine, vault: b.vault, bundlePath, workDir: join(root, "b-work") });
      assert.equal(outcome.status, "finished", show(outcome));
      assert.equal(outcome.symbols, 1);
      assert.equal(outcome.verified, 1);

      // symbol resolvable on the restored instance, byte-identical
      const restored = b.engine.findSymbolArtifact(identity.debugFile, identity.debugId, "pdb");
      assert.ok(restored !== undefined);
      const reader = b.vault.openSymbol(restored.artifactId);
      assert.ok(reader !== undefined);
      try {
        assert.equal(reader.size, BigInt(symbolBytes.byteLength));
        assert.deepEqual(Buffer.from(reader.read(0n, symbolBytes.byteLength)), symbolBytes);
      } finally {
        reader.close();
      }
      assert.equal(b.engine.snapshot().symbols.length, 1);

      // the dump still imports identically
      assert.deepEqual(comparable(b.engine.snapshot()), comparable(populated.snapshot));
      const dumpReader = b.vault.openImmutable(populated.dumpId);
      try {
        assert.deepEqual(Buffer.from(dumpReader.read(0n, populated.dumpBytes.byteLength)), populated.dumpBytes);
      } finally {
        dumpReader.close();
      }

      a.engine.close();
      b.engine.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("omitting the flag is the pre-flag bundle, and imports without symbols", async () => {
    const root = mkdtempSync(join(tmpdir(), "dump-ledger-symbols-off-"));
    try {
      const a = makeInstance(join(root, "a"));
      const symbolBytes = syntheticPdb("C:\\build\\out\\electron.pdb", pdbGuid(), 7);
      const identity = parsePdbIdentity(symbolBytes, "electron.pdb")!;
      const populated = populate(a, symbolBytes, identity);

      const { bundlePath } = await exportTo(a, join(root, "a-exports"));
      const bundleBytes = readFileSync(bundlePath);
      assert.deepEqual(entryNames(bundleBytes), ["manifest.json", "ledger.sqlite", dumpEntryName(populated.dumpId)]);
      const manifest = manifestOf(bundlePath);
      assert.equal(manifest.symbols, undefined);
      assert.equal(manifest.counts.symbols, undefined);
      assert.ok(!new TextDecoder().decode(entryBytes(bundleBytes, "manifest.json")).includes("\"symbols\""));

      const b = makeInstance(join(root, "b"));
      b.inspection.facts = a.inspection.facts;
      const outcome = importBundle({ engine: b.engine, vault: b.vault, bundlePath });
      assert.equal(outcome.status, "finished", show(outcome));
      assert.equal(outcome.symbols, 0);
      assert.equal(b.engine.snapshot().symbols.length, 0);
      assert.deepEqual(comparable(b.engine.snapshot()), comparable(populated.snapshot));

      a.engine.close();
      b.engine.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("re-imports onto an instance that already holds the identity as a single-artifact no-op", async () => {
    const root = mkdtempSync(join(tmpdir(), "dump-ledger-symbols-dedup-"));
    try {
      const a = makeInstance(join(root, "a"));
      const symbolBytes = syntheticPdb("C:\\build\\out\\electron.pdb", pdbGuid(), 7);
      const identity = parsePdbIdentity(symbolBytes, "electron.pdb")!;
      populate(a, symbolBytes, identity);
      const { bundlePath } = await exportTo(a, join(root, "a-exports"), true);

      // The target already holds the same identity (symbol artifacts are not
      // part of the empty-ledger import guard): the carried artifact must dedup.
      const b = makeInstance(join(root, "b"));
      const preexisting = seedSymbol(b, symbolBytes, identity);
      const outcome = importBundle({ engine: b.engine, vault: b.vault, bundlePath, workDir: join(root, "b-work") });
      assert.equal(outcome.status, "finished", show(outcome));
      assert.equal(outcome.symbols, 1);
      const symbols = b.engine.snapshot().symbols;
      assert.equal(symbols.length, 1, "a deduplicated re-import must not add a second artifact");
      assert.equal(symbols[0]?.artifactId, preexisting);
      assert.ok(!existsSync(join(b.root, "vault", "symbols-staging", `${symbols[0]?.artifactId}.part`)), "staging residue must be removed");

      a.engine.close();
      b.engine.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails the import (no FinishImport, nothing landed) when a carried symbol's digest is wrong", async () => {
    const root = mkdtempSync(join(tmpdir(), "dump-ledger-symbols-tamper-"));
    try {
      const a = makeInstance(join(root, "a"));
      const symbolBytes = syntheticPdb("C:\\build\\out\\electron.pdb", pdbGuid(), 7);
      const identity = parsePdbIdentity(symbolBytes, "electron.pdb")!;
      const populated = populate(a, symbolBytes, identity);
      const { bundlePath } = await exportTo(a, join(root, "a-exports"), true);

      const tampered = Buffer.from(readFileSync(bundlePath));
      const offset = entryDataOffset(tampered, symbolEntryName(populated.artifactId));
      tampered[offset + 64] = tampered[offset + 64]! ^ 0xff;
      const tamperedPath = join(root, "tampered.tar");
      writeFileSync(tamperedPath, tampered);

      const b = makeInstance(join(root, "b"));
      const outcome = importBundle({ engine: b.engine, vault: b.vault, bundlePath: tamperedPath });
      assert.equal(outcome.status, "failed", show(outcome));
      assert.match(outcome.error ?? "", /sha256 mismatch/);
      assert.equal(b.engine.snapshot().symbols.length, 0, "a corrupt symbol must not land");
      assert.equal(b.engine.snapshot().auditEvents.some(event => event.action === "FinishImport"), false);
      assert.deepEqual(readdirSync(join(b.root, "vault", "symbols-staging")), [], "staging residue must be removed");

      a.engine.close();
      b.engine.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails the import when the carried bytes carry no readable identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "dump-ledger-symbols-unreadable-"));
    try {
      const a = makeInstance(join(root, "a"));
      // The engine trusts the identity it is handed; bytes that are not a PDB
      // can only be caught when the bundle is re-ingested.
      const garbage = Buffer.from("not a pdb at all");
      const identity = { debugFile: "electron.pdb", debugId: "3A9C1F2E4B5D6789012345678ABCDEF1" };
      const populated = populate(a, garbage, identity);
      const { bundlePath } = await exportTo(a, join(root, "a-exports"), true);

      const b = makeInstance(join(root, "b"));
      const outcome = importBundle({ engine: b.engine, vault: b.vault, bundlePath });
      assert.equal(outcome.status, "failed", show(outcome));
      assert.match(outcome.error ?? "", /unreadable or mismatched identity/);
      assert.equal(b.engine.snapshot().symbols.length, 0);
      assert.equal(b.engine.snapshot().auditEvents.some(event => event.action === "FinishImport"), false);
      assert.notEqual(populated.artifactId, "");

      a.engine.close();
      b.engine.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("export request surface (includeSymbols)", () => {
  const FIXED_NOW = "2026-09-04T12:00:00.000Z";

  async function makeServerFixture(): Promise<{ readonly server: ReturnType<typeof buildHttpServer>; readonly exportsDir: string; readonly cleanup: () => void }> {
    const exportsDir = mkdtempSync(join(tmpdir(), "dump-ledger-symbols-http-"));
    const vault = new MemoryVault();
    const engine = createDumpLedgerEngine({
      databasePath: ":memory:",
      vault,
      inspection: new ScriptedInspection(),
      grantSecretKey: GRANT_KEY,
      clock: new DeterministicClock(FIXED_NOW),
      entropy: new DeterministicEntropy([...SECRETS]),
      ids: new RandomIds(),
    });
    const transfer = new TransferManager({ engine, vault, exportsDir });
    const sessions = new OperatorSessions({ passwordHash: await hashOperatorPassword("local-password"), secureCookies: false });
    const options: HttpServerOptions = {
      application: new EngineHttpApplication(engine, vault),
      sessions,
      uploadLifecycle: new EngineUploadLifecycle(engine),
      uploadSink: new VaultUploadSink(vault),
      uploadPostProcessor: new EngineUploadPostProcessor(engine),
      now: () => Date.parse(FIXED_NOW),
      transfer,
      transferExportsDir: exportsDir,
    };
    const server = buildHttpServer(options);
    return { server, exportsDir, cleanup: () => { void server.close(); engine.close(); rmSync(exportsDir, { recursive: true, force: true }); } };
  }

  async function login(server: ReturnType<typeof buildHttpServer>): Promise<{ cookie: string; csrf: string }> {
    const response = await server.inject({ method: "POST", url: "/api/v1/session", headers: { "content-type": "application/json" }, payload: JSON.stringify({ password: "local-password" }) });
    assert.equal(response.statusCode, 200);
    const body = response.json() as { csrfToken?: string };
    const setCookie = response.headers["set-cookie"];
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";", 1)[0];
    assert.ok(cookie !== undefined && body.csrfToken !== undefined);
    return { cookie, csrf: body.csrfToken };
  }

  async function waitForExport(server: ReturnType<typeof buildHttpServer>, cookie: string, exportId: string): Promise<ExportSummary> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const response = await server.inject({ method: "GET", url: "/api/v1/operations/exports", headers: { cookie } });
      assert.equal(response.statusCode, 200);
      const found = decodeListExportsResponse(response.json(), "$").exports.find(entry => entry.exportId === exportId);
      if (found !== undefined && found.status !== "running") return found;
      assert.ok(Date.now() < deadline, `export ${exportId} did not settle`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }

  it("accepts an optional includeSymbols body and rejects malformed variants", async t => {
    const { server, exportsDir, cleanup } = await makeServerFixture();
    t.after(cleanup);
    const auth = await login(server);
    const headers = { cookie: auth.cookie, [CSRF_HEADER]: auth.csrf, "content-type": "application/json" };

    // flag on: the manifest records the request (no artifacts registered, so the list is empty)
    const created = await server.inject({ method: "POST", url: "/api/v1/operations/exports", headers, payload: JSON.stringify({ includeSymbols: true }) });
    assert.equal(created.statusCode, 201, created.body);
    const { exportId } = decodeCreateExportResponse(created.json(), "$");
    const sealed = await waitForExport(server, auth.cookie, exportId);
    assert.equal(sealed.status, "sealed", sealed.error ?? "export failed");
    const manifest = manifestOf(join(exportsDir, exportId, "bundle.tar"));
    assert.deepEqual(manifest.symbols, []);
    assert.equal(manifest.counts.symbols, 0);

    // flag omitted: no symbols field at all
    const createdDefault = await server.inject({ method: "POST", url: "/api/v1/operations/exports", headers, payload: JSON.stringify({}) });
    assert.equal(createdDefault.statusCode, 201, createdDefault.body);
    const defaultSealed = await waitForExport(server, auth.cookie, decodeCreateExportResponse(createdDefault.json(), "$").exportId);
    assert.equal(defaultSealed.status, "sealed", defaultSealed.error ?? "export failed");
    const defaultManifest = manifestOf(join(exportsDir, defaultSealed.exportId, "bundle.tar"));
    assert.equal(defaultManifest.symbols, undefined);
    assert.equal(defaultManifest.counts.symbols, undefined);

    // malformed bodies are rejected before any job starts
    for (const payload of [JSON.stringify({ includeSymbols: "yes" }), JSON.stringify({ symbols: true }), JSON.stringify([true]), "not json"]) {
      const rejected = await server.inject({ method: "POST", url: "/api/v1/operations/exports", headers, payload });
      assert.equal(rejected.statusCode, 400, payload);
      assert.equal(decodeErrorResponse(rejected.json(), "$").error.code, "invalid_request");
    }
  });
});
