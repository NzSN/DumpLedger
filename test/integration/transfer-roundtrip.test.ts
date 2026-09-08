import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import BetterSqlite3 from "better-sqlite3";
import { DumpLedgerError } from "../../src/domain/errors.js";
import type { DumpId, GrantId } from "../../src/domain/ids.js";
import { RandomIds } from "../../src/engine/dependencies.js";
import {
  createDumpLedgerEngine,
  DeterministicClock,
  DeterministicEntropy,
  type DumpLedgerEngine,
} from "../../src/engine/dump-ledger-engine.js";
import type { DumpLedgerProjection, TransitionReceipt, TransitionSuccess } from "../../src/engine/projection.js";
import { createVaultMinidumpInspectionPort } from "../../src/inspection/index.js";
import { applyMigrations } from "../../src/ledger/migrations.js";
import { exportBundle, type BundleTargetFactory } from "../../src/transfer/export.js";
import { importBundle, type ImportOutcome } from "../../src/transfer/import.js";
import { dumpEntryName, serializeExportManifest } from "../../src/transfer/manifest.js";
import { TransferManager } from "../../src/transfer/manager.js";
import { createTarWriter, readTar, type TarSource } from "../../src/transfer/tar.js";
import { FilesystemVault } from "../../src/vault/filesystem-vault.js";
import { syntheticMinidump } from "../fixtures/minidump/synthetic-minidump.js";

const T0 = "2026-09-04T00:00:00.000Z";
const T1 = "2026-10-04T00:00:00.000Z";
const GRANT_KEY = Uint8Array.from({ length: 32 }, () => 0x41);
const OTHER_KEY = Uint8Array.from({ length: 32 }, () => 0x42);
const SECRETS = ["roundtrip-secret-00000000000000001", "roundtrip-secret-00000000000000002", "roundtrip-secret-00000000000000003"];

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

interface Instance {
  readonly root: string;
  readonly engine: DumpLedgerEngine;
  readonly vault: FilesystemVault;
}

/** A fully real instance: filesystem vault, SQLite ledger, minidump inspection port; deterministic clock and grant secrets. */
function makeInstance(root: string, grantSecretKey: Uint8Array = GRANT_KEY): Instance {
  mkdirSync(root, { recursive: true });
  const vault = new FilesystemVault(join(root, "vault"));
  const engine = createDumpLedgerEngine({
    databasePath: join(root, "ledger.sqlite"),
    vault,
    inspection: createVaultMinidumpInspectionPort(vault),
    grantSecretKey,
    clock: new DeterministicClock(T0),
    entropy: new DeterministicEntropy([...SECRETS]),
    ids: new RandomIds(),
  });
  return { root, engine, vault };
}

interface Populated {
  readonly dumpAvailable: DumpId;
  readonly dumpDeleted: DumpId;
  readonly dumpBytes: Buffer;
  readonly grantIssued: GrantId;
  readonly snapshot: DumpLedgerProjection;
}

function upload(instance: Instance, grantSecret: string, bytes: Uint8Array, originalName: string): DumpId {
  const begun = must(instance.engine.execute({ type: "BeginUpload", grantSecret, originalName }));
  const dumpId = begun.dumpId!;
  instance.vault.append(dumpId, bytes);
  instance.vault.syncAndClose(dumpId);
  must(instance.engine.execute({ type: "SealUpload", dumpId, byteSize: BigInt(bytes.byteLength), sha256: sha256hex(bytes) }));
  must(instance.engine.execute({ type: "PromoteObject", dumpId }));
  must(instance.engine.execute({ type: "MarkQuarantined", dumpId }));
  return dumpId;
}

/** Mirrors EngineUploadPostProcessor: accept, or reject when inspection says no. */
function settleInspection(instance: Instance, dumpId: DumpId): "available" | "rejected" {
  const accepted = instance.engine.execute({ type: "AcceptDump", dumpId });
  if (accepted.ok) return "available";
  assert.ok(!accepted.ok && accepted.error.code === "inspection_outcome_mismatch", show(accepted));
  must(instance.engine.execute({ type: "RejectDump", dumpId }));
  return "rejected";
}

/** Two customers, two cases, three grants (one outstanding), one available dump, one rejected-then-purged dump. */
function populate(instance: Instance): Populated {
  const customer1 = must(instance.engine.execute({ type: "CreateCustomer", displayName: "Acme" })).customerId!;
  const customer2 = must(instance.engine.execute({ type: "CreateCustomer", displayName: "Globex" })).customerId!;
  const case1 = must(instance.engine.execute({ type: "CreateCase", customerId: customer1, title: "Kernel panic" })).caseId!;
  const case2 = must(instance.engine.execute({ type: "CreateCase", customerId: customer2, title: "Userspace crash" })).caseId!;
  must(instance.engine.execute({ type: "StartInvestigation", caseId: case1 }));
  const grant1 = must(instance.engine.execute({ type: "IssueGrant", caseId: case1, expiresAt: T1, maxBytes: 16n * 1024n * 1024n }));
  const grant2 = must(instance.engine.execute({ type: "IssueGrant", caseId: case2, expiresAt: T1, maxBytes: 16n * 1024n * 1024n }));
  const grant3 = must(instance.engine.execute({ type: "IssueGrant", caseId: case2, expiresAt: T1, maxBytes: 1024n }));
  const dumpBytes = syntheticMinidump({ flags: 0x2n, memory64ListSizes: [256, 512] });
  const dumpAvailable = upload(instance, grant1.grantSecret!, dumpBytes, "crash.dmp");
  assert.equal(settleInspection(instance, dumpAvailable), "available");
  must(instance.engine.execute({ type: "SetRetention", dumpId: dumpAvailable, purgeAt: T1 }));
  const garbage = Uint8Array.from({ length: 600 }, (_unused, index) => index % 251);
  const dumpDeleted = upload(instance, grant2.grantSecret!, garbage, "junk.dmp");
  assert.equal(settleInspection(instance, dumpDeleted), "rejected");
  must(instance.engine.execute({ type: "BeginPurge", dumpId: dumpDeleted }));
  must(instance.engine.execute({ type: "FinishPurge", dumpId: dumpDeleted }));
  return { dumpAvailable, dumpDeleted, dumpBytes, grantIssued: grant3.grantId!, snapshot: instance.engine.snapshot() };
}

function comparable(snapshot: DumpLedgerProjection): Pick<DumpLedgerProjection, "customers" | "cases" | "grants" | "dumps" | "downloadable"> {
  return { customers: snapshot.customers, cases: snapshot.cases, grants: snapshot.grants, dumps: snapshot.dumps, downloadable: snapshot.downloadable };
}

function bufferSource(bytes: Uint8Array): TarSource {
  return { size: BigInt(bytes.byteLength), read: (position, length) => bytes.slice(Number(position), Number(position) + length) };
}

/** Entry names in archive order; iterating also validates the whole archive structure. */
function entryOrder(bytes: Uint8Array): string[] {
  return [...readTar(bufferSource(bytes))].map(entry => entry.name);
}

function entryDataOffset(bytes: Uint8Array, name: string): number {
  let offset = 0;
  for (const entry of readTar(bufferSource(bytes))) {
    const dataOffset = offset + 512;
    if (entry.name === name) return dataOffset;
    const size = Number(entry.size);
    offset = dataOffset + size + ((512 - (size % 512)) % 512);
  }
  throw new Error(`tar entry not found: ${name}`);
}

/** Replaces an entry name (same length) and rewrites the header checksum so only the reader's own checks reject it. */
function patchEntryName(bytes: Buffer, from: string, to: string): void {
  assert.equal(from.length, to.length);
  const headerOffset = entryDataOffset(bytes, from) - 512;
  bytes.write(to, headerOffset, "ascii");
  fixChecksum(bytes, headerOffset);
}

function fixChecksum(bytes: Buffer, headerOffset: number): void {
  for (let index = 0; index < 8; index += 1) bytes[headerOffset + 148 + index] = 0x20;
  let sum = 0;
  for (let index = 0; index < 512; index += 1) sum += bytes[headerOffset + index]!;
  const digits = sum.toString(8).padStart(6, "0");
  for (let index = 0; index < 6; index += 1) bytes[headerOffset + 148 + index] = digits.charCodeAt(index);
  bytes[headerOffset + 154] = 0x00;
  bytes[headerOffset + 155] = 0x20;
}

function buildTar(entries: ReadonlyArray<{ readonly name: string; readonly data: Uint8Array }>): Buffer {
  const chunks: Buffer[] = [];
  const writer = createTarWriter({ write: chunk => chunks.push(Buffer.from(chunk)) });
  for (const entry of entries) {
    const entryWriter = writer.addEntry(entry.name, BigInt(entry.data.byteLength));
    entryWriter.append(entry.data);
    entryWriter.finish();
  }
  writer.finish();
  return Buffer.concat(chunks);
}

/** An empty but structurally valid bundle: migrated empty ledger + zero-count manifest. */
function buildEmptyBundle(workRoot: string): Buffer {
  mkdirSync(workRoot, { recursive: true });
  const ledgerPath = join(workRoot, "empty.sqlite");
  const database = new BetterSqlite3(ledgerPath);
  applyMigrations(database);
  const version = (database.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number }).version;
  database.close();
  const manifest = serializeExportManifest({
    schema: "dump-ledger.export-manifest/v1",
    createdAt: T0,
    generator: { version: "0.1.0", schemaMigrations: version },
    grantKeyFingerprint: createHash("sha256").update(GRANT_KEY).digest("base64url"),
    counts: { customers: 0, cases: 0, grants: 0, dumps: 0, auditEvents: 0 },
    skipped: [],
    dumps: [],
  });
  const ledger = readFileSync(ledgerPath);
  rmSync(ledgerPath, { force: true });
  return buildTar([
    { name: "manifest.json", data: manifest },
    { name: "ledger.sqlite", data: ledger },
  ]);
}

describe("transfer round trip", () => {
  it("exports a populated instance and imports it byte-identically through a real tar bundle", async () => {
    const root = mkdtempSync(join(tmpdir(), "dump-ledger-roundtrip-"));
    try {
      const a = makeInstance(join(root, "a"));
      const populated = populate(a);
      const exportsDir = join(root, "a-exports");
      const summary = await exportBundle({ engine: a.engine, vault: a.vault, exportsDir });
      assert.equal(summary.status, "sealed", show(summary));
      assert.equal(summary.error, null);
      const bundlePath = join(exportsDir, summary.exportId, "bundle.tar");
      assert.ok(existsSync(bundlePath));
      const bundleBytes = readFileSync(bundlePath);
      assert.equal(summary.byteSize, BigInt(bundleBytes.byteLength).toString());
      // deterministic layout: manifest, ledger, then vault entries sorted by dump id; tombstones carry no bytes
      assert.deepEqual(entryOrder(bundleBytes), ["manifest.json", "ledger.sqlite", dumpEntryName(populated.dumpAvailable)]);

      const b = makeInstance(join(root, "b"));
      const outcome = importBundle({ engine: b.engine, vault: b.vault, bundlePath, workDir: join(root, "b-work") });
      assert.equal(outcome.status, "finished", show(outcome));
      assert.equal(outcome.error, null);
      assert.deepEqual(
        { verified: outcome.verified, imported: outcome.imported, rejected: outcome.rejected, skipped: outcome.skipped },
        { verified: 1, imported: 2, rejected: 0, skipped: 0 },
      );
      assert.ok(outcome.engineImportId !== null);

      // full field equality on the comparable projection
      assert.deepEqual(comparable(b.engine.snapshot()), comparable(populated.snapshot));

      // byte-identical dump content in B's vault
      const reader = b.vault.openImmutable(populated.dumpAvailable);
      try {
        assert.equal(reader.size, BigInt(populated.dumpBytes.byteLength));
        assert.deepEqual(Buffer.from(reader.read(0n, populated.dumpBytes.byteLength)), populated.dumpBytes);
      } finally {
        reader.close();
      }

      // audit trail preserved: historical events present (verbatim), before FinishImport
      const events = b.engine.snapshot().auditEvents;
      const historicalIds = new Set(populated.snapshot.auditEvents.map(event => event.eventId));
      const historical = events.filter(event => historicalIds.has(event.eventId));
      assert.deepEqual(historical, populated.snapshot.auditEvents);
      const finishIndex = events.findIndex(event => event.action === "FinishImport");
      assert.equal(finishIndex, events.length - 1);
      assert.ok(historical.every(event => events.indexOf(event) < finishIndex));
      assert.equal(events[0]?.action, "BeginImport");
      assert.equal(events[finishIndex]?.detail.importId, outcome.engineImportId);

      a.engine.close();
      b.engine.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("imports a tampered dump as rejected while the rest of the bundle succeeds", async () => {
    const root = mkdtempSync(join(tmpdir(), "dump-ledger-tampered-"));
    try {
      const a = makeInstance(join(root, "a"));
      const populated = populate(a);
      const summary = await exportBundle({ engine: a.engine, vault: a.vault, exportsDir: join(root, "a-exports") });
      assert.equal(summary.status, "sealed", show(summary));
      const bundleBytes = readFileSync(join(root, "a-exports", summary.exportId, "bundle.tar"));
      const offset = entryDataOffset(bundleBytes, dumpEntryName(populated.dumpAvailable));
      bundleBytes[offset + 128] = bundleBytes[offset + 128]! ^ 0xff;
      const tamperedPath = join(root, "tampered.tar");
      writeFileSync(tamperedPath, bundleBytes);

      const b = makeInstance(join(root, "b"));
      const outcome = importBundle({ engine: b.engine, vault: b.vault, bundlePath: tamperedPath });
      assert.equal(outcome.status, "finished", show(outcome));
      assert.equal(outcome.verified, 0);
      assert.equal(outcome.rejected, 1);
      assert.equal(outcome.imported, 1); // the deleted tombstone still imports

      const snapshot = b.engine.snapshot();
      const tampered = snapshot.dumps.find(dump => dump.dumpId === populated.dumpAvailable)!;
      assert.equal(tampered.phase, "rejected");
      assert.equal(tampered.validation, "transfer-failed");
      assert.equal(tampered.inspectionError, "import sha256 mismatch");
      assert.equal(tampered.blobState, "none");
      assert.equal(tampered.downloadable, false);
      assert.deepEqual(b.vault.inspectPresence(populated.dumpAvailable), { staging: false, vault: false });
      const tombstone = snapshot.dumps.find(dump => dump.dumpId === populated.dumpDeleted)!;
      assert.equal(tombstone.phase, "deleted");
      assert.equal(snapshot.customers.length, 2);
      assert.equal(snapshot.cases.length, 2);
      assert.equal(snapshot.grants.length, 3);
      assert.deepEqual(snapshot.downloadable, []);

      a.engine.close();
      b.engine.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("imports outstanding grants as revoked when the grant key differs", async () => {
    const root = mkdtempSync(join(tmpdir(), "dump-ledger-wrongkey-"));
    try {
      const a = makeInstance(join(root, "a"));
      const populated = populate(a);
      const summary = await exportBundle({ engine: a.engine, vault: a.vault, exportsDir: join(root, "a-exports") });
      assert.equal(summary.status, "sealed", show(summary));

      const b = makeInstance(join(root, "b"), OTHER_KEY);
      assert.notEqual(b.engine.grantKeyFingerprint(), a.engine.grantKeyFingerprint());
      const outcome = importBundle({ engine: b.engine, vault: b.vault, bundlePath: join(root, "a-exports", summary.exportId, "bundle.tar") });
      assert.equal(outcome.status, "finished", show(outcome));

      const grants = b.engine.snapshot().grants;
      const outstanding = grants.find(grant => grant.grantId === populated.grantIssued)!;
      assert.equal(outstanding.state, "revoked");
      const consumed = grants.filter(grant => grant.consumedByDumpId !== null);
      assert.equal(consumed.length, 2);
      assert.ok(consumed.every(grant => grant.state === "consumed"));

      a.engine.close();
      b.engine.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects traversal, forged typeflags, duplicates, and unexpected entries before any engine mutation", () => {
    const root = mkdtempSync(join(tmpdir(), "dump-ledger-invalid-"));
    try {
      const good = buildEmptyBundle(join(root, "empty"));

      // control: the structurally valid empty bundle imports cleanly
      const control = makeInstance(join(root, "control"));
      const controlPath = join(root, "control.tar");
      writeFileSync(controlPath, good);
      const controlOutcome = importBundle({ engine: control.engine, vault: control.vault, bundlePath: controlPath });
      assert.equal(controlOutcome.status, "finished", show(controlOutcome));
      control.engine.close();

      const cases: Array<{ readonly name: string; readonly build: () => Buffer }> = [
        {
          name: "traversal entry name",
          build: () => {
            const bytes = buildTar([
              { name: "manifest.json", data: entrySlice(good, "manifest.json") },
              { name: "ledger.sqlite", data: entrySlice(good, "ledger.sqlite") },
              { name: "evil.txt", data: Uint8Array.of(1) },
            ]);
            patchEntryName(bytes, "evil.txt", "../e.txt");
            return bytes;
          },
        },
        {
          name: "symlink typeflag on manifest",
          build: () => {
            const bytes = Buffer.from(good);
            const headerOffset = entryDataOffset(bytes, "manifest.json") - 512;
            bytes[headerOffset + 156] = 0x32; // '2': symlink
            fixChecksum(bytes, headerOffset);
            return bytes;
          },
        },
        {
          name: "duplicate entry name",
          build: () =>
            buildTar([
              { name: "manifest.json", data: entrySlice(good, "manifest.json") },
              { name: "manifest.json", data: entrySlice(good, "manifest.json") },
              { name: "ledger.sqlite", data: entrySlice(good, "ledger.sqlite") },
            ]),
        },
        {
          name: "unexpected top-level entry",
          build: () =>
            buildTar([
              { name: "manifest.json", data: entrySlice(good, "manifest.json") },
              { name: "ledger.sqlite", data: entrySlice(good, "ledger.sqlite") },
              { name: "evil.txt", data: Uint8Array.of(1) },
            ]),
        },
      ];

      for (const variant of cases) {
        const instance = makeInstance(join(root, `target-${variant.name.replaceAll(" ", "-")}`));
        const path = join(root, `${variant.name.replaceAll(" ", "-")}.tar`);
        writeFileSync(path, variant.build());
        const outcome = importBundle({ engine: instance.engine, vault: instance.vault, bundlePath: path });
        assert.equal(outcome.status, "failed", `${variant.name}: ${show(outcome)}`);
        assert.equal(outcome.engineImportId, null, `${variant.name}: import must fail before BeginImport`);
        const snapshot = instance.engine.snapshot();
        assert.equal(snapshot.customers.length, 0, variant.name);
        assert.equal(snapshot.auditEvents.length, 0, `${variant.name}: no engine mutation allowed`);
        instance.engine.close();
      }

      // bundle path policy: symlinks and non-.tar paths are refused before opening
      const symlinkPath = join(root, "linked.tar");
      symlinkSync(controlPath, symlinkPath);
      const viaSymlink = makeInstance(join(root, "symlink-target"));
      const symlinkOutcome = importBundle({ engine: viaSymlink.engine, vault: viaSymlink.vault, bundlePath: symlinkPath });
      assert.equal(symlinkOutcome.status, "failed");
      assert.equal(viaSymlink.engine.snapshot().auditEvents.length, 0);
      viaSymlink.engine.close();

      const wrongSuffix = join(root, "bundle.tarx");
      writeFileSync(wrongSuffix, good);
      const viaSuffix = makeInstance(join(root, "suffix-target"));
      const suffixOutcome = importBundle({ engine: viaSuffix.engine, vault: viaSuffix.vault, bundlePath: wrongSuffix });
      assert.equal(suffixOutcome.status, "failed");
      assert.equal(viaSuffix.engine.snapshot().auditEvents.length, 0);
      viaSuffix.engine.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("an aborted export leaves no sealed bundle behind", async () => {
    const root = mkdtempSync(join(tmpdir(), "dump-ledger-abort-"));
    try {
      const a = makeInstance(join(root, "a"));
      const populated = populate(a);

      // (1) injected sink failure
      const exportsDir = join(root, "exports-sink");
      let sealed = false;
      const targetFactory: BundleTargetFactory = () => ({
        sink: {
          write: () => {
            throw new DumpLedgerError("storage_unavailable", "injected sink failure");
          },
        },
        seal: () => {
          sealed = true;
        },
        discard: () => {},
      });
      const failed = await exportBundle({ engine: a.engine, vault: a.vault, exportsDir, targetFactory });
      assert.equal(failed.status, "failed");
      assert.match(failed.error ?? "", /injected sink failure/);
      assert.equal(sealed, false, "a failing sink must never be sealed");
      assert.deepEqual(readdirSync(exportsDir), [], "work directory must be removed");

      // (2) the race policy: vault bytes vanish before the copy -> retryable abort, no bundle
      rmSync(join(a.vault.vaultRoot, populated.dumpAvailable, "original.dmp"));
      const raced = await exportBundle({ engine: a.engine, vault: a.vault, exportsDir: join(root, "exports-race") });
      assert.equal(raced.status, "failed");
      assert.match(raced.error ?? "", /retryable/);
      assert.ok(!existsSync(join(root, "exports-race", raced.exportId)), "aborted export must not leave a bundle directory");

      const manager = new TransferManager({ engine: a.engine, vault: a.vault, exportsDir });
      assert.deepEqual(manager.listExports(), []);
      a.engine.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs one transfer job at a time and reconciles the exports directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "dump-ledger-manager-"));
    try {
      const a = makeInstance(join(root, "a"));
      populate(a);
      const exportsDir = join(root, "exports");
      const manager = new TransferManager({ engine: a.engine, vault: a.vault, exportsDir });

      const first = manager.startExport();
      assert.throws(() => manager.startExport(), (error: unknown) => error instanceof DumpLedgerError && error.code === "invalid_transition");
      assert.throws(() => manager.startImport("irrelevant.tar"), (error: unknown) => error instanceof DumpLedgerError && error.code === "invalid_transition");
      const sealed = await first;
      assert.equal(sealed.status, "sealed", show(sealed));
      assert.equal(manager.getExport(sealed.exportId)?.status, "sealed");

      // once finished, another job may run
      const second = await manager.startExport();
      assert.equal(second.status, "sealed");
      assert.equal(manager.listExports().length, 2);

      // import through the manager on a fresh instance
      const b = makeInstance(join(root, "b"));
      const managerB = new TransferManager({ engine: b.engine, vault: b.vault, exportsDir: join(root, "b-exports") });
      const job = await managerB.startImport(join(exportsDir, sealed.exportId, "bundle.tar"));
      assert.equal(job.status, "finished", show(job));
      assert.equal(job.imported, 2);
      assert.deepEqual(managerB.getImport(job.importId), job);

      // startup scan: sealed bundles listed from disk, leftover .part work areas removed
      const leftover = join(exportsDir, `export_${"0".repeat(32)}`);
      mkdirSync(leftover, { recursive: true });
      writeFileSync(join(leftover, "bundle.tar.part"), "partial");
      const leftoverImport = join(exportsDir, "import-deadbeef");
      mkdirSync(leftoverImport, { recursive: true });
      writeFileSync(join(leftoverImport, "ledger.sqlite"), "partial");
      const rescanned = new TransferManager({ engine: a.engine, vault: a.vault, exportsDir });
      assert.ok(!existsSync(leftover), "leftover .part directory must be removed at startup");
      assert.ok(!existsSync(leftoverImport), "leftover import work directory must be removed at startup");
      const listed = rescanned.listExports();
      assert.equal(listed.length, 2);
      assert.ok(listed.every(item => item.status === "sealed" && item.byteSize !== null));
      assert.ok(listed.some(item => item.exportId === sealed.exportId));

      // deleteExport removes a sealed bundle and its record
      rescanned.deleteExport(sealed.exportId);
      assert.equal(rescanned.getExport(sealed.exportId), undefined);
      assert.ok(!existsSync(join(exportsDir, sealed.exportId)));
      assert.throws(() => rescanned.deleteExport(sealed.exportId), (error: unknown) => error instanceof DumpLedgerError && error.code === "not_found");

      a.engine.close();
      b.engine.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** Extracts one entry's data from a tar buffer (used to rebuild malicious variants from the valid empty bundle). */
function entrySlice(bytes: Uint8Array, name: string): Uint8Array {
  const offset = entryDataOffset(bytes, name);
  const entry = [...readTar(bufferSource(bytes))].find(candidate => candidate.name === name)!;
  return bytes.slice(offset, offset + Number(entry.size));
}
