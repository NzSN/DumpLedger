import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { describe, it } from "node:test";
import {
  createDumpLedgerEngine,
  DeterministicClock,
  DeterministicEntropy,
  DeterministicIds,
  type DumpLedgerEngine,
  type ImportCounts,
  type ImportDumpRecord,
  type ImportGrantRecord,
  type InspectionPort,
} from "../../src/engine/dump-ledger-engine.js";
import type { DumpLedgerProjection, DumpProjection, GrantProjection, TransitionReceipt, TransitionSuccess } from "../../src/engine/projection.js";
import type { AuditEventId, CaseId, CustomerId, DumpId, GrantId } from "../../src/domain/ids.js";
import { MemoryVault } from "../../src/vault/memory-vault.js";

const T0 = "2026-09-04T00:00:00.000Z";
const T1 = "2026-09-05T00:00:00.000Z";
const GRANT_KEY = Uint8Array.from({ length: 32 }, () => 0x41);
const MANIFEST_DIGEST = createHash("sha256").update("manifest.json").digest("base64url");
const EMPTY_COUNTS: ImportCounts = { customers: 0, cases: 0, grants: 0, dumps: 0 };
const okInspection: InspectionPort = { inspect: () => ({ ok: true, coverage: "partial", facts: {} }) };

const CUSTOMER_A = `customer_${"0".repeat(25)}1` as CustomerId;
const CUSTOMER_MISSING = `customer_${"9".repeat(26)}` as CustomerId;
const CASE_A = `case_${"0".repeat(25)}1` as CaseId;
const CASE_B = `case_${"0".repeat(25)}2` as CaseId;
const GRANT_A = `grant_${"0".repeat(25)}1` as GrantId;
const GRANT_B = `grant_${"0".repeat(25)}2` as GrantId;
const GRANT_C = `grant_${"0".repeat(25)}3` as GrantId;
const DUMP_A = `dump_${"0".repeat(25)}1` as DumpId;
const DUMP_B = `dump_${"0".repeat(25)}2` as DumpId;
const MISSING_IMPORT = `audit_${"9".repeat(26)}` as AuditEventId;

function secretAt(index: number): string { return `import-test-secret-${String(index).padStart(20, "0")}`; }

interface Harness { readonly engine: DumpLedgerEngine; readonly vault: MemoryVault; readonly clock: DeterministicClock }
function harness(options: { readonly inspection?: InspectionPort; readonly secrets?: number; readonly grantSecretKey?: Uint8Array; readonly idOffset?: number } = {}): Harness {
  const clock = new DeterministicClock(T0);
  const vault = new MemoryVault();
  const entropy = Array.from({ length: options.secrets ?? 2 }, (_unused, index) => secretAt(index));
  const engine = createDumpLedgerEngine({
    databasePath: ":memory:",
    vault,
    inspection: options.inspection ?? okInspection,
    grantSecretKey: options.grantSecretKey ?? GRANT_KEY,
    clock,
    entropy: new DeterministicEntropy(entropy),
    ids: new DeterministicIds(options.idOffset ?? 0),
  });
  return { engine, vault, clock };
}
function show(value: unknown): string { return JSON.stringify(value, (_key, item: unknown) => typeof item === "bigint" ? item.toString() : item); }
function succeeded(receipt: TransitionReceipt): TransitionSuccess { assert.ok(receipt.ok, show(receipt)); return receipt; }
function failed(receipt: TransitionReceipt, code: string): void { assert.ok(!receipt.ok, show(receipt)); assert.equal(receipt.error.code, code); }
function grantDigest(secret: string): string { return createHmac("sha256", GRANT_KEY).update(secret, "utf8").digest("hex"); }
function grantRecord(grant: GrantProjection, secret: string): ImportGrantRecord {
  return { grantId: grant.grantId, caseId: grant.caseId, secretDigest: grantDigest(secret), state: grant.state, expiresAt: grant.expiresAt, maxBytes: grant.maxBytes, consumedByDumpId: grant.consumedByDumpId, createdAt: grant.createdAt };
}
function dumpRecord(dump: DumpProjection, phase: "available" | "rejected" | "deleted"): ImportDumpRecord {
  return { dumpId: dump.dumpId, caseId: dump.caseId, phase, originalName: dump.originalName, byteSize: dump.byteSize, sha256: dump.sha256, validation: dump.validation, coverage: dump.coverage, inspectionError: dump.inspectionError, receivedAt: dump.receivedAt, availableAt: dump.availableAt, purgeAt: dump.purgeAt, purgedAt: dump.purgedAt };
}
function comparable(snapshot: DumpLedgerProjection): Pick<DumpLedgerProjection, "customers" | "cases" | "grants" | "dumps" | "downloadable"> {
  return { customers: snapshot.customers, cases: snapshot.cases, grants: snapshot.grants, dumps: snapshot.dumps, downloadable: snapshot.downloadable };
}

describe("engine import commands", () => {
  it("guards the empty-ledger precondition and the import marker lifecycle", () => {
    const populated = harness({ secrets: 0 });
    succeeded(populated.engine.execute({ type: "CreateCustomer", displayName: "Acme" }));
    failed(populated.engine.execute({ type: "BeginImport", manifestDigest: MANIFEST_DIGEST, counts: EMPTY_COUNTS }), "invalid_transition");
    populated.engine.close();

    const { engine } = harness({ secrets: 0 });
    failed(engine.execute({ type: "ImportCustomer", record: { customerId: CUSTOMER_A, displayName: "Acme", createdAt: T0 } }), "invalid_transition");
    failed(engine.execute({ type: "FinishImport", importId: MISSING_IMPORT, summary: { imported: EMPTY_COUNTS, skipped: 0 } }), "not_found");
    const begun = succeeded(engine.execute({ type: "BeginImport", manifestDigest: MANIFEST_DIGEST, counts: EMPTY_COUNTS }));
    const importId = begun.importId!;
    assert.match(importId, /^audit_[0-9A-HJKMNP-TV-Z]{26}$/);
    failed(engine.execute({ type: "BeginImport", manifestDigest: MANIFEST_DIGEST, counts: EMPTY_COUNTS }), "invalid_transition");
    succeeded(engine.execute({ type: "FinishImport", importId, summary: { imported: EMPTY_COUNTS, skipped: 0 } }));
    failed(engine.execute({ type: "FinishImport", importId, summary: { imported: EMPTY_COUNTS, skipped: 0 } }), "invalid_transition");
    const restarted = succeeded(engine.execute({ type: "BeginImport", manifestDigest: MANIFEST_DIGEST, counts: EMPTY_COUNTS }));
    assert.ok(restarted.importId !== undefined && restarted.importId !== importId);
    engine.close();
  });

  it("round-trips customers, cases, grants, and dumps with preserved identifiers and timestamps", () => {
    const a = harness();
    const customer1 = succeeded(a.engine.execute({ type: "CreateCustomer", displayName: "Acme" })).customerId!;
    const case1 = succeeded(a.engine.execute({ type: "CreateCase", customerId: customer1, title: "Crash" })).caseId!;
    succeeded(a.engine.execute({ type: "StartInvestigation", caseId: case1 }));
    const grant1 = succeeded(a.engine.execute({ type: "IssueGrant", caseId: case1, expiresAt: T1, maxBytes: 1024n }));
    const customer2 = succeeded(a.engine.execute({ type: "CreateCustomer", displayName: "Globex" })).customerId!;
    const case2 = succeeded(a.engine.execute({ type: "CreateCase", customerId: customer2, title: "Second" })).caseId!;
    succeeded(a.engine.execute({ type: "IssueGrant", caseId: case2, expiresAt: T1, maxBytes: 2048n }));
    const bytes = Uint8Array.from({ length: 32 }, (_unused, index) => index);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const begun = succeeded(a.engine.execute({ type: "BeginUpload", grantSecret: grant1.grantSecret!, originalName: "crash.dmp" }));
    const dumpId = begun.dumpId!;
    a.vault.append(dumpId, bytes);
    a.vault.syncAndClose(dumpId);
    succeeded(a.engine.execute({ type: "SealUpload", dumpId, byteSize: BigInt(bytes.byteLength), sha256 }));
    succeeded(a.engine.execute({ type: "PromoteObject", dumpId }));
    succeeded(a.engine.execute({ type: "MarkQuarantined", dumpId }));
    succeeded(a.engine.execute({ type: "AcceptDump", dumpId }));

    const source = a.engine.snapshot();
    assert.equal(source.dumps.length, 1);
    assert.equal(source.dumps[0]!.phase, "available");
    const secretsByGrant = new Map<GrantId, string>([[grant1.grantId!, secretAt(0)]]);
    for (const grant of source.grants) if (!secretsByGrant.has(grant.grantId)) secretsByGrant.set(grant.grantId, secretAt(1));

    const b = harness({ secrets: 0 });
    assert.equal(b.engine.grantKeyFingerprint(), a.engine.grantKeyFingerprint());
    assert.equal(a.engine.grantKeyFingerprint(), createHash("sha256").update(GRANT_KEY).digest("base64url"));
    const counts: ImportCounts = { customers: 2, cases: 2, grants: 2, dumps: 1 };
    const importId = succeeded(b.engine.execute({ type: "BeginImport", manifestDigest: MANIFEST_DIGEST, counts })).importId!;
    for (const customer of source.customers) succeeded(b.engine.execute({ type: "ImportCustomer", record: customer }));
    for (const supportCase of source.cases) succeeded(b.engine.execute({ type: "ImportCase", record: supportCase }));
    for (const grant of source.grants) succeeded(b.engine.execute({ type: "ImportGrant", record: grantRecord(grant, secretsByGrant.get(grant.grantId)!) }));
    const dump = source.dumps[0]!;
    b.vault.createStaging(dumpId);
    b.vault.append(dumpId, bytes);
    b.vault.syncAndClose(dumpId);
    const staged = succeeded(b.engine.execute({ type: "ImportDumpStaged", record: dumpRecord(dump, "available") }));
    assert.equal(staged.phase, "sealed");
    const stagedDump = b.engine.snapshot().dumps[0]!;
    assert.equal(stagedDump.phase, "sealed");
    assert.equal(stagedDump.blobState, "staging");
    assert.equal(stagedDump.receivedAt, dump.receivedAt);
    succeeded(b.engine.execute({ type: "PromoteObject", dumpId }));
    succeeded(b.engine.execute({ type: "MarkQuarantined", dumpId }));
    succeeded(b.engine.execute({ type: "AcceptDump", dumpId }));
    succeeded(b.engine.execute({ type: "FinishImport", importId, summary: { imported: counts, skipped: 0 } }));

    assert.deepEqual(comparable(b.engine.snapshot()), comparable(source));
    a.engine.close();
    b.engine.close();
  });

  it("imports outstanding grants as revoked when forcedState applies the fingerprint policy", () => {
    const other = harness({ secrets: 0, grantSecretKey: Uint8Array.from({ length: 32 }, () => 0x42) });
    const { engine } = harness({ secrets: 0 });
    assert.notEqual(other.engine.grantKeyFingerprint(), engine.grantKeyFingerprint());
    other.engine.close();

    const importId = succeeded(engine.execute({ type: "BeginImport", manifestDigest: MANIFEST_DIGEST, counts: { customers: 1, cases: 1, grants: 3, dumps: 0 } })).importId!;
    succeeded(engine.execute({ type: "ImportCustomer", record: { customerId: CUSTOMER_A, displayName: "Acme", createdAt: T0 } }));
    const caseId = succeeded(engine.execute({ type: "ImportCase", record: { caseId: CASE_A, customerId: CUSTOMER_A, title: "Crash", status: "closed", createdAt: T0 } })).caseId!;
    const base = { caseId, expiresAt: T1, maxBytes: 64n, createdAt: T0 };
    succeeded(engine.execute({ type: "ImportGrant", record: { ...base, grantId: GRANT_A, secretDigest: "a".repeat(64), state: "issued", consumedByDumpId: null }, forcedState: "revoked" }));
    succeeded(engine.execute({ type: "ImportGrant", record: { ...base, grantId: GRANT_B, secretDigest: "b".repeat(64), state: "consumed", consumedByDumpId: DUMP_A }, forcedState: "revoked" }));
    succeeded(engine.execute({ type: "ImportGrant", record: { ...base, grantId: GRANT_C, secretDigest: "c".repeat(64), state: "issued", consumedByDumpId: null } }));
    succeeded(engine.execute({ type: "FinishImport", importId, summary: { imported: { customers: 1, cases: 1, grants: 3, dumps: 0 }, skipped: 0 } }));

    const grants = engine.snapshot().grants;
    assert.deepEqual(grants.map(grant => grant.state), ["revoked", "consumed", "issued"]);
    assert.equal(grants[0]!.createdAt, T0);
    assert.equal(grants[1]!.consumedByDumpId, DUMP_A);
    const grantEvents = engine.snapshot().auditEvents.filter(event => event.action === "ImportGrant");
    assert.deepEqual(grantEvents.map(event => event.detail.forced), [true, false, false]);
    assert.deepEqual(grantEvents.map(event => event.detail.state), ["revoked", "consumed", "issued"]);
    engine.close();
  });

  it("imports rejected and deleted dumps as metadata-only tombstones", () => {
    const { engine, vault } = harness({ secrets: 0 });
    const importId = succeeded(engine.execute({ type: "BeginImport", manifestDigest: MANIFEST_DIGEST, counts: { customers: 1, cases: 1, grants: 0, dumps: 2 } })).importId!;
    succeeded(engine.execute({ type: "ImportCustomer", record: { customerId: CUSTOMER_A, displayName: "Acme", createdAt: T0 } }));
    succeeded(engine.execute({ type: "ImportCase", record: { caseId: CASE_A, customerId: CUSTOMER_A, title: "Crash", status: "resolved", createdAt: T0 } }));
    const rejected = succeeded(engine.execute({ type: "ImportDumpStaged", record: { dumpId: DUMP_A, caseId: CASE_A, phase: "rejected", originalName: "bad.dmp", byteSize: 4n, sha256: "a".repeat(64), validation: "invalid", coverage: null, inspectionError: "not a minidump", receivedAt: T0, availableAt: null, purgeAt: T1, purgedAt: null } }));
    assert.equal(rejected.phase, "rejected");
    const deleted = succeeded(engine.execute({ type: "ImportDumpStaged", record: { dumpId: DUMP_B, caseId: CASE_A, phase: "deleted", originalName: "gone.dmp", byteSize: 8n, sha256: "b".repeat(64), validation: "valid", coverage: "partial", inspectionError: null, receivedAt: T0, availableAt: T0, purgeAt: null, purgedAt: T1 } }));
    assert.equal(deleted.phase, "deleted");
    succeeded(engine.execute({ type: "FinishImport", importId, summary: { imported: { customers: 1, cases: 1, grants: 0, dumps: 2 }, skipped: 0 } }));

    const dumps = engine.snapshot().dumps;
    const rejectedDump = dumps.find(dump => dump.dumpId === DUMP_A)!;
    assert.equal(rejectedDump.phase, "rejected");
    assert.equal(rejectedDump.blobState, "none");
    assert.equal(rejectedDump.validation, "invalid");
    assert.equal(rejectedDump.inspectionError, "not a minidump");
    assert.equal(rejectedDump.purgeAt, T1);
    assert.equal(rejectedDump.downloadable, false);
    assert.deepEqual(vault.inspectPresence(DUMP_A), { staging: false, vault: false });
    const deletedDump = dumps.find(dump => dump.dumpId === DUMP_B)!;
    assert.equal(deletedDump.blobState, "none");
    assert.equal(deletedDump.purgedAt, T1);
    failed(engine.execute({ type: "AcceptDump", dumpId: DUMP_B }), "invalid_transition");
    assert.deepEqual(engine.dueForPurge(T1), [DUMP_A]);
    succeeded(engine.execute({ type: "BeginPurge", dumpId: DUMP_A }));
    succeeded(engine.execute({ type: "FinishPurge", dumpId: DUMP_A }));
    assert.equal(engine.snapshot().dumps.find(dump => dump.dumpId === DUMP_A)!.phase, "deleted");
    engine.close();
  });

  it("drives staged imports to a terminal phase only through quarantine and inspection", () => {
    const rejecting: InspectionPort = { inspect: () => ({ ok: false, error: "truncated header" }) };
    const { engine, vault } = harness({ secrets: 0, inspection: rejecting });
    const importId = succeeded(engine.execute({ type: "BeginImport", manifestDigest: MANIFEST_DIGEST, counts: { customers: 1, cases: 1, grants: 0, dumps: 1 } })).importId!;
    succeeded(engine.execute({ type: "ImportCustomer", record: { customerId: CUSTOMER_A, displayName: "Acme", createdAt: T0 } }));
    succeeded(engine.execute({ type: "ImportCase", record: { caseId: CASE_A, customerId: CUSTOMER_A, title: "Crash", status: "new", createdAt: T0 } }));
    const record: ImportDumpRecord = { dumpId: DUMP_A, caseId: CASE_A, phase: "available", originalName: "crash.dmp", byteSize: 4n, sha256: "a".repeat(64), validation: "valid", coverage: "partial", inspectionError: null, receivedAt: T0, availableAt: T0, purgeAt: null, purgedAt: null };
    failed(engine.execute({ type: "ImportDumpStaged", record }), "integrity_failure");
    vault.createStaging(DUMP_A);
    vault.append(DUMP_A, Uint8Array.of(1, 2, 3, 4));
    vault.syncAndClose(DUMP_A);
    const staged = succeeded(engine.execute({ type: "ImportDumpStaged", record }));
    assert.equal(staged.phase, "sealed");
    failed(engine.execute({ type: "AcceptDump", dumpId: DUMP_A }), "invalid_transition");
    failed(engine.execute({ type: "MarkQuarantined", dumpId: DUMP_A }), "integrity_failure");
    succeeded(engine.execute({ type: "PromoteObject", dumpId: DUMP_A }));
    succeeded(engine.execute({ type: "MarkQuarantined", dumpId: DUMP_A }));
    failed(engine.execute({ type: "AcceptDump", dumpId: DUMP_A }), "inspection_outcome_mismatch");
    succeeded(engine.execute({ type: "RejectDump", dumpId: DUMP_A }));
    succeeded(engine.execute({ type: "FinishImport", importId, summary: { imported: { customers: 1, cases: 1, grants: 0, dumps: 1 }, skipped: 0 } }));

    const dump = engine.snapshot().dumps[0]!;
    assert.equal(dump.phase, "rejected");
    assert.equal(dump.blobState, "vault");
    assert.equal(dump.validation, "invalid");
    assert.equal(dump.inspectionError, "truncated header");
    assert.equal(dump.coverage, null);
    assert.equal(dump.availableAt, null);
    assert.equal(dump.receivedAt, T0);
    engine.close();
  });

  it("emits an audit event per import command without leaking digests", () => {
    const { engine, vault } = harness({ secrets: 0 });
    const counts: ImportCounts = { customers: 1, cases: 1, grants: 1, dumps: 1 };
    const importId = succeeded(engine.execute({ type: "BeginImport", manifestDigest: MANIFEST_DIGEST, counts })).importId!;
    succeeded(engine.execute({ type: "ImportCustomer", record: { customerId: CUSTOMER_A, displayName: "Acme", createdAt: T0 } }));
    const caseId = succeeded(engine.execute({ type: "ImportCase", record: { caseId: CASE_A, customerId: CUSTOMER_A, title: "Crash", status: "new", createdAt: T0 } })).caseId!;
    const digest = grantDigest("import-test-secret-never-issued-0000");
    succeeded(engine.execute({ type: "ImportGrant", record: { grantId: GRANT_A, caseId, secretDigest: digest, state: "issued", expiresAt: T1, maxBytes: 64n, consumedByDumpId: null, createdAt: T0 } }));
    failed(engine.execute({ type: "ImportCustomer", record: { customerId: CUSTOMER_A, displayName: "Duplicate", createdAt: T0 } }), "invalid_input");
    failed(engine.execute({ type: "ImportCase", record: { caseId: CASE_B, customerId: CUSTOMER_MISSING, title: "Orphan", status: "new", createdAt: T0 } }), "not_found");
    vault.createStaging(DUMP_A);
    vault.append(DUMP_A, Uint8Array.of(1, 2, 3, 4));
    vault.syncAndClose(DUMP_A);
    succeeded(engine.execute({ type: "ImportDumpStaged", record: { dumpId: DUMP_A, caseId, phase: "available", originalName: "crash.dmp", byteSize: 4n, sha256: "a".repeat(64), validation: "valid", coverage: "partial", inspectionError: null, receivedAt: T0, availableAt: T0, purgeAt: null, purgedAt: null } }));
    succeeded(engine.execute({ type: "FinishImport", importId, summary: { imported: counts, skipped: 1 } }));

    const events = engine.snapshot().auditEvents;
    assert.deepEqual(events.map(event => event.action), ["BeginImport", "ImportCustomer", "ImportCase", "ImportGrant", "ImportDumpStaged", "FinishImport"]);
    const [beginEvent, , , grantEvent, dumpEvent, finishEvent] = events;
    assert.equal(beginEvent!.detail.manifestDigest, MANIFEST_DIGEST);
    assert.equal(beginEvent!.detail.importId, importId);
    assert.deepEqual(beginEvent!.detail.counts, counts);
    assert.equal(grantEvent!.caseId, caseId);
    assert.equal(grantEvent!.detail.state, "issued");
    assert.equal(grantEvent!.detail.forced, false);
    assert.equal(dumpEvent!.dumpId, DUMP_A);
    assert.deepEqual(dumpEvent!.detail, { exportedPhase: "available", disposition: "staged" });
    assert.equal(finishEvent!.detail.importId, importId);
    assert.equal(finishEvent!.detail.manifestDigest, MANIFEST_DIGEST);
    assert.deepEqual(finishEvent!.detail.imported, counts);
    assert.equal(finishEvent!.detail.skipped, 1);
    assert.ok(!JSON.stringify(events).includes(digest));
    engine.close();
  });

  it("restores historical audit events verbatim between the import markers", () => {
    const a = harness();
    const customerId = succeeded(a.engine.execute({ type: "CreateCustomer", displayName: "Acme" })).customerId!;
    const caseId = succeeded(a.engine.execute({ type: "CreateCase", customerId, title: "Crash" })).caseId!;
    succeeded(a.engine.execute({ type: "StartInvestigation", caseId }));
    const source = a.engine.snapshot();
    const history = source.auditEvents;
    assert.equal(history.length, 3);

    const b = harness({ secrets: 0, idOffset: 10_000 });
    const counts: ImportCounts = { customers: 1, cases: 1, grants: 0, dumps: 0, auditEvents: history.length };
    const importId = succeeded(b.engine.execute({ type: "BeginImport", manifestDigest: MANIFEST_DIGEST, counts })).importId!;
    succeeded(b.engine.execute({ type: "ImportCustomer", record: source.customers[0]! }));
    succeeded(b.engine.execute({ type: "ImportCase", record: source.cases[0]! }));
    for (const event of history) succeeded(b.engine.execute({ type: "ImportAuditEvent", record: event }));
    failed(b.engine.execute({ type: "ImportAuditEvent", record: history[0]! }), "invalid_input");
    succeeded(b.engine.execute({ type: "FinishImport", importId, summary: { imported: counts, skipped: 0 } }));

    const restored = b.engine.snapshot().auditEvents;
    assert.deepEqual(
      restored.map(event => event.action),
      ["BeginImport", "ImportCustomer", "ImportCase", ...history.map(event => event.action), "FinishImport"],
    );
    assert.deepEqual(restored.slice(3, 3 + history.length), history);
    a.engine.close();
    b.engine.close();
  });

  it("rejects historical audit events when no import is in progress", () => {
    const { engine } = harness({ secrets: 0 });
    failed(
      engine.execute({ type: "ImportAuditEvent", record: { eventId: MISSING_IMPORT, occurredAt: T0, action: "CreateCustomer", customerId: null, caseId: null, dumpId: null, detail: {} } }),
      "invalid_transition",
    );
    engine.close();
  });
});
