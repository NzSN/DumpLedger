import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { bindRichFixture, richFixture } from "../../packages/http-contracts/test/rich-fixture.js";
import type { RecordRichAnalysisRequest } from "@dump-ledger/http-contracts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import BetterSqlite3 from "better-sqlite3";

import { parseDumpId, type DumpId } from "../../src/domain/ids.js";
import {
  createDumpLedgerEngine,
  DeterministicClock,
  DeterministicEntropy,
  DeterministicIds,
  type DumpLedgerEngine,
} from "../../src/engine/dump-ledger-engine.js";
import type { LifecycleCommand } from "../../src/engine/commands.js";
import { applyMigrations } from "../../src/ledger/migrations.js";
import { SqliteLedger } from "../../src/ledger/sqlite-ledger.js";
import { MemoryVault } from "../../src/vault/memory-vault.js";

/**
 * Integration coverage for analysis write-back (docs/analyzer-integration-design.md,
 * "Analysis write-back"; milestone AI3 task G2): the RecordAnalysis engine
 * command over the dump lifecycle, identity-tuple replay, the read-through
 * listAnalyses, the purge cascade, the audit feed row, and migration 8 on a
 * seeded version-7 file. Drives a real SQLite ledger in a temp directory and
 * records dumps through the lifecycle so their shape matches production.
 */

const CLOCK = "2026-10-13T00:00:00.000Z";
const EXPIRY = "2027-01-01T00:00:00.000Z";
const SHA = "a".repeat(64);
const ANALYZER = { name: "crash-triage", version: "1.2.3" } as const;
const SECRETS = Array.from({ length: 16 }, (_unused, index) => `analysis-secret-${String(index).padStart(20, "0")}`);

interface Context {
  readonly engine: DumpLedgerEngine;
  readonly vault: MemoryVault;
  readonly databasePath: string;
  close(): void;
}

function withEngine(run: (context: Context) => void): void {
  const root = mkdtempSync(join(tmpdir(), "dump-ledger-analysis-"));
  const databasePath = join(root, "ledger.sqlite");
  const vault = new MemoryVault();
  const engine = createDumpLedgerEngine({
    databasePath,
    vault,
    inspection: { inspect: () => ({ ok: true, coverage: "partial", facts: {} }) },
    grantSecretKey: Uint8Array.from({ length: 32 }, () => 0x41),
    clock: new DeterministicClock(CLOCK),
    entropy: new DeterministicEntropy([...SECRETS]),
    ids: new DeterministicIds(),
  });
  let closed = false;
  const context: Context = {
    engine,
    vault,
    databasePath,
    close: () => {
      if (!closed) {
        closed = true;
        engine.close();
      }
    },
  };
  try {
    run(context);
  } finally {
    context.close();
    rmSync(root, { recursive: true, force: true });
  }
}

/** One upload in phase `receiving`: fresh customer/case/grant, bytes staged. */
function startUpload(engine: DumpLedgerEngine, vault: MemoryVault): DumpId {
  const customer = engine.execute({ type: "CreateCustomer", displayName: "Acme" });
  assert.ok(customer.ok && customer.customerId !== undefined);
  const created = engine.execute({ type: "CreateCase", customerId: customer.customerId, title: "Renderer crash" });
  assert.ok(created.ok && created.caseId !== undefined);
  const grant = engine.execute({ type: "IssueGrant", caseId: created.caseId, expiresAt: EXPIRY, maxBytes: 1_000_000n });
  assert.ok(grant.ok && grant.grantSecret !== undefined);
  const begun = engine.execute({ type: "BeginUpload", grantSecret: grant.grantSecret, originalName: "crash.dmp" });
  assert.ok(begun.ok && begun.dumpId !== undefined);
  vault.append(begun.dumpId, Uint8Array.of(1, 2, 3, 4));
  vault.syncAndClose(begun.dumpId);
  return begun.dumpId;
}

/** One sealed upload: fresh customer/case/grant, bytes staged, digest sealed. */
function beginUpload(engine: DumpLedgerEngine, vault: MemoryVault): DumpId {
  const dumpId = startUpload(engine, vault);
  assert.ok(engine.execute({ type: "SealUpload", dumpId, byteSize: 4n, sha256: SHA }).ok);
  return dumpId;
}

function createAvailableDump(engine: DumpLedgerEngine, vault: MemoryVault): DumpId {
  const dumpId = beginUpload(engine, vault);
  assert.ok(engine.execute({ type: "PromoteObject", dumpId }).ok);
  assert.ok(engine.execute({ type: "MarkQuarantined", dumpId }).ok);
  assert.ok(engine.execute({ type: "AcceptDump", dumpId }).ok);
  return dumpId;
}

function versionList(database: BetterSqlite3.Database): readonly number[] {
  return (database.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>).map(row => row.version);
}

describe("RecordAnalysis engine command (AI3 G2)", () => {
  it("records a fresh report with server identity and the contract field set", () => {
    withEngine(({ engine, vault }) => {
      const dumpId = createAvailableDump(engine, vault);
      const facts = { architecture: "x86_64", nested: { code: "c0000005", offsets: ["1", "2"] } };
      const receipt = engine.execute({
        type: "RecordAnalysis", dumpId, analyzerName: ANALYZER.name, analyzerVersion: ANALYZER.version,
        kind: "triage", inputSha256: SHA, outcome: "completed", summary: "Parsed the exception stream", facts,
      });
      assert.ok(receipt.ok && receipt.replayed === false && receipt.analysis !== undefined);
      const report = receipt.analysis;
      assert.match(report.analysisId, /^analysis_[0-9A-HJKMNP-TV-Z]{26}$/);
      assert.equal(report.dumpId, dumpId);
      assert.deepEqual(report.analyzer, { name: ANALYZER.name, version: ANALYZER.version });
      assert.equal(report.kind, "triage");
      assert.equal(report.inputSha256, SHA);
      assert.equal(report.outcome, "completed");
      assert.equal(report.summary, "Parsed the exception stream");
      assert.deepEqual(report.facts, facts);
      assert.equal(report.duplicateOf, null);
      assert.equal(report.createdAt, CLOCK);
      assert.deepEqual(engine.listAnalyses(dumpId), [report]);
    });
  });

  it("replays the identity tuple without a second row or audit event", () => {
    withEngine(({ engine, vault, databasePath, close }) => {
      const dumpId = createAvailableDump(engine, vault);
      const first = engine.execute({
        type: "RecordAnalysis", dumpId, analyzerName: ANALYZER.name, analyzerVersion: ANALYZER.version,
        kind: "triage", inputSha256: SHA, outcome: "completed", summary: "first pass",
      });
      assert.ok(first.ok && first.replayed === false && first.analysis !== undefined);
      // The repeat hits the same identity tuple; its differing body is ignored
      // and the stored report comes back with `replayed: true`.
      const replay = engine.execute({
        type: "RecordAnalysis", dumpId, analyzerName: ANALYZER.name, analyzerVersion: ANALYZER.version,
        kind: "triage", inputSha256: SHA, outcome: "failed", summary: "second pass, different summary",
      });
      assert.ok(replay.ok && replay.replayed === true && replay.analysis !== undefined);
      assert.equal(replay.analysis.analysisId, first.analysis.analysisId);
      assert.deepEqual(replay.analysis, first.analysis);
      assert.deepEqual(engine.listAnalyses(dumpId), [first.analysis]);
      assert.equal(engine.readAuditEvents(0, { actions: ["RecordAnalysis"] }).events.length, 1);
      close();
      const database = new BetterSqlite3(databasePath, { readonly: true });
      try {
        assert.equal((database.prepare("SELECT COUNT(*) AS count FROM dump_analyses").get() as { count: number }).count, 1);
      } finally {
        database.close();
      }
    });
  });

  it("rejects an inputSha256 that does not match the sealed dump hash", () => {
    withEngine(({ engine, vault }) => {
      const dumpId = createAvailableDump(engine, vault);
      const receipt = engine.execute({
        type: "RecordAnalysis", dumpId, analyzerName: ANALYZER.name, analyzerVersion: ANALYZER.version,
        kind: "triage", inputSha256: "b".repeat(64), outcome: "completed", summary: "",
      });
      assert.ok(!receipt.ok);
      assert.equal(receipt.error.code, "invalid_input");
      assert.deepEqual(engine.listAnalyses(dumpId), []);
      assert.equal(engine.readAuditEvents(0, { actions: ["RecordAnalysis"] }).events.length, 0);
    });
  });

  it("rejects missing, rejected, and deleted dumps by state", () => {
    withEngine(({ engine, vault }) => {
      const body = {
        analyzerName: ANALYZER.name, analyzerVersion: ANALYZER.version,
        kind: "triage", inputSha256: SHA, outcome: "completed", summary: "",
      } as const;

      const missing = engine.execute({ type: "RecordAnalysis", dumpId: parseDumpId("dump_00000000000000000000000099"), ...body });
      assert.ok(!missing.ok);
      assert.equal(missing.error.code, "not_found");

      const interrupted = startUpload(engine, vault);
      assert.ok(engine.execute({ type: "FailUpload", dumpId: interrupted }).ok);
      const onRejected = engine.execute({ type: "RecordAnalysis", dumpId: interrupted, ...body });
      assert.ok(!onRejected.ok);
      assert.equal(onRejected.error.code, "invalid_transition");

      const deleted = createAvailableDump(engine, vault);
      assert.ok(engine.execute({ type: "BeginPurge", dumpId: deleted }).ok);
      assert.ok(engine.execute({ type: "FinishPurge", dumpId: deleted }).ok);
      const onDeleted = engine.execute({ type: "RecordAnalysis", dumpId: deleted, ...body });
      assert.ok(!onDeleted.ok);
      assert.equal(onDeleted.error.code, "invalid_transition");
      assert.deepEqual(engine.listAnalyses(deleted), []);
    });
  });

  it("round-trips facts including their absence, ordered by (created_at, analysis_id)", () => {
    withEngine(({ engine, vault }) => {
      const dumpId = createAvailableDump(engine, vault);
      const facts = { modules: [{ name: "electron.exe", warm: true }], zeros: [0, -1.5e10], empty: {} };
      const withFacts = engine.execute({
        type: "RecordAnalysis", dumpId, analyzerName: ANALYZER.name, analyzerVersion: ANALYZER.version,
        kind: "triage", inputSha256: SHA, outcome: "failed", summary: "Symbols missing", facts,
      });
      assert.ok(withFacts.ok && withFacts.analysis !== undefined);
      const withoutFacts = engine.execute({
        type: "RecordAnalysis", dumpId, analyzerName: ANALYZER.name, analyzerVersion: ANALYZER.version,
        kind: "classification", inputSha256: SHA, outcome: "completed", summary: "No facts supplied",
      });
      assert.ok(withoutFacts.ok && withoutFacts.analysis !== undefined);
      assert.equal(withoutFacts.analysis.facts, null);
      const listed = engine.listAnalyses(dumpId);
      assert.equal(listed.length, 2);
      assert.deepEqual(listed[0], withFacts.analysis);
      assert.deepEqual(listed[1], withoutFacts.analysis);
      assert.deepEqual(listed[0]?.facts, facts);
      assert.equal(listed[1]?.facts, null);
    });
  });

  it("stores duplicateOf as null when absent and as the named dump when set", () => {
    withEngine(({ engine, vault }) => {
      const dumpId = createAvailableDump(engine, vault);
      const otherDumpId = createAvailableDump(engine, vault);
      const plain = engine.execute({
        type: "RecordAnalysis", dumpId, analyzerName: ANALYZER.name, analyzerVersion: ANALYZER.version,
        kind: "triage", inputSha256: SHA, outcome: "completed", summary: "",
      });
      assert.ok(plain.ok && plain.analysis !== undefined);
      assert.equal(plain.analysis.duplicateOf, null);
      const duplicate = engine.execute({
        type: "RecordAnalysis", dumpId, analyzerName: ANALYZER.name, analyzerVersion: ANALYZER.version,
        kind: "duplicate-check", inputSha256: SHA, outcome: "completed", summary: "", duplicateOf: otherDumpId,
      });
      assert.ok(duplicate.ok && duplicate.analysis !== undefined);
      assert.equal(duplicate.analysis.duplicateOf, otherDumpId);
      const explicitNull = engine.execute({
        type: "RecordAnalysis", dumpId, analyzerName: ANALYZER.name, analyzerVersion: ANALYZER.version,
        kind: "classification", inputSha256: SHA, outcome: "completed", summary: "", duplicateOf: null,
      });
      assert.ok(explicitNull.ok && explicitNull.analysis !== undefined);
      assert.equal(explicitNull.analysis.duplicateOf, null);
      assert.deepEqual(engine.listAnalyses(dumpId).map(report => report.duplicateOf), [null, otherDumpId, null]);
    });
  });

  it("removes every report in the purge-finish transaction while the dump row is tombstoned", () => {
    withEngine(({ engine, vault, databasePath, close }) => {
      const dumpId = createAvailableDump(engine, vault);
      for (const kind of ["triage", "symbolication"]) {
        const receipt = engine.execute({
          type: "RecordAnalysis", dumpId, analyzerName: ANALYZER.name, analyzerVersion: ANALYZER.version,
          kind, inputSha256: SHA, outcome: "completed", summary: "", facts: { kind },
        });
        assert.ok(receipt.ok);
      }
      assert.equal(engine.listAnalyses(dumpId).length, 2);
      assert.ok(engine.execute({ type: "BeginPurge", dumpId }).ok);
      assert.ok(engine.execute({ type: "FinishPurge", dumpId }).ok);
      assert.deepEqual(engine.listAnalyses(dumpId), []);
      close();
      const database = new BetterSqlite3(databasePath, { readonly: true });
      try {
        assert.equal((database.prepare("SELECT COUNT(*) AS count FROM dump_analyses WHERE dump_id = ?").get(dumpId) as { count: number }).count, 0);
        // The dump row survives as a tombstone, which is exactly why the purge
        // cascade has to be explicit: no ON DELETE trigger can ever fire.
        assert.equal((database.prepare("SELECT phase FROM dumps WHERE dump_id = ?").get(dumpId) as { phase: string }).phase, "deleted");
      } finally {
        database.close();
      }
    });
  });

  it("lands one RecordAnalysis audit event carrying identifiers and outcome only", () => {
    withEngine(({ engine, vault }) => {
      const dumpId = createAvailableDump(engine, vault);
      const receipt = engine.execute({
        type: "RecordAnalysis", dumpId, analyzerName: ANALYZER.name, analyzerVersion: ANALYZER.version,
        kind: "triage", inputSha256: SHA, outcome: "failed", summary: "Kernel dump unusable", facts: { secret: "not in the feed" },
      });
      assert.ok(receipt.ok && receipt.analysis !== undefined && receipt.caseId !== undefined);
      const events = engine.readAuditEvents(0, { actions: ["RecordAnalysis"] }).events;
      assert.equal(events.length, 1);
      const event = events[0];
      assert.ok(event !== undefined);
      assert.equal(event.action, "RecordAnalysis");
      assert.equal(event.occurredAt, CLOCK);
      assert.equal(event.dumpId, dumpId);
      assert.equal(event.caseId, receipt.caseId);
      assert.notEqual(event.customerId, null);
      assert.deepEqual(event.detail, {
        analysisId: receipt.analysis.analysisId,
        dumpId,
        caseId: receipt.caseId,
        analyzerName: ANALYZER.name,
        analyzerVersion: ANALYZER.version,
        kind: "triage",
        outcome: "failed",
      });
      assert.equal("summary" in event.detail, false);
      assert.equal("facts" in event.detail, false);
    });
  });

  it("rejects bodies outside the contract bounds", () => {
    withEngine(({ engine, vault }) => {
      const dumpId = createAvailableDump(engine, vault);
      const base = {
        type: "RecordAnalysis", dumpId, analyzerName: ANALYZER.name, analyzerVersion: ANALYZER.version,
        kind: "triage", inputSha256: SHA, outcome: "completed", summary: "",
      } as const;
      const invalid = (overrides: Readonly<Record<string, unknown>>): LifecycleCommand => ({ ...base, ...overrides }) as LifecycleCommand;
      const cases: ReadonlyArray<{ readonly label: string; readonly command: LifecycleCommand }> = [
        { label: "empty kind", command: invalid({ kind: "" }) },
        { label: "kind over 64 characters", command: invalid({ kind: "k".repeat(65) }) },
        { label: "summary over 2000 characters", command: invalid({ summary: "s".repeat(2001) }) },
        { label: "control character in summary", command: invalid({ summary: "bad\u0000summary" }) },
        { label: "control character in analyzer name", command: invalid({ analyzerName: "bad\nname" }) },
        { label: "analyzer name over 128 characters", command: invalid({ analyzerName: "n".repeat(129) }) },
        { label: "analyzer version over 64 characters", command: invalid({ analyzerVersion: "v".repeat(65) }) },
        { label: "malformed inputSha256", command: invalid({ inputSha256: "zz" }) },
        { label: "unknown outcome", command: invalid({ outcome: "maybe" }) },
        { label: "facts over 4096 serialized bytes", command: invalid({ facts: { blob: "x".repeat(5000) } }) },
        { label: "facts not an object", command: invalid({ facts: [1, 2, 3] }) },
        { label: "facts with a non-JSON value", command: invalid({ facts: { fn: () => 1 } }) },
        { label: "malformed duplicateOf", command: invalid({ duplicateOf: "not-a-dump-id" }) },
      ];
      for (const { label, command } of cases) {
        const receipt = engine.execute(command);
        assert.ok(!receipt.ok, label);
        assert.equal(receipt.error.code, "invalid_input", label);
      }
      assert.deepEqual(engine.listAnalyses(dumpId), []);
      assert.equal(engine.readAuditEvents(0, { actions: ["RecordAnalysis"] }).events.length, 0);
    });
  });
});

describe("migration 8 (dump_analyses)", () => {
  const NOW = "2026-10-01T00:00:00.000Z";
  const CUSTOMER_ID = "customer_00000000000000000000000001";
  const CASE_ID = "case_00000000000000000000000001";
  const GRANT_ID = "grant_00000000000000000000000001";
  const DUMP_ID = "dump_00000000000000000000000001";
  const EVENT_ID = "audit_00000000000000000000000001";
  const ANALYSIS_ID = "analysis_00000000000000000000000001";

  it("preserves a seeded version-7 file and enforces the identity tuple and dump reference", () => {
    const root = mkdtempSync(join(tmpdir(), "dump-ledger-analysis-v7-"));
    const databasePath = join(root, "ledger.sqlite");
    try {
      const database = new BetterSqlite3(databasePath);
      try {
        database.pragma("foreign_keys = ON");
        applyMigrations(database, 7);
        database.prepare("INSERT INTO customers(customer_id, display_name, created_at) VALUES (?, ?, ?)").run(CUSTOMER_ID, "Acme", NOW);
        database.prepare("INSERT INTO cases(case_id, customer_id, title, status, created_at) VALUES (?, ?, ?, 'investigating', ?)").run(CASE_ID, CUSTOMER_ID, "Renderer crash", NOW);
        database.prepare("INSERT INTO upload_grants(grant_id, case_id, secret_digest, state, expires_at, max_bytes, consumed_by_dump_id, created_at, max_uploads, uploads_used) VALUES (?, ?, ?, 'consumed', ?, ?, ?, ?, 1, 1)").run(GRANT_ID, CASE_ID, "digest-v7", EXPIRY, "4", DUMP_ID, NOW);
        database.prepare("INSERT INTO dumps(dump_id, case_id, phase, blob_state, original_name, byte_size, sha256, validation, coverage, downloadable, inspection_error, inspection_facts_json, received_at, available_at, purge_at, purged_at) VALUES (?, ?, 'available', 'vault', 'crash.dmp', '4', ?, 'valid', 'partial', 1, NULL, NULL, ?, ?, NULL, NULL)").run(DUMP_ID, CASE_ID, SHA, NOW, NOW);
        database.prepare("INSERT INTO audit_events(event_id, occurred_at, action, customer_id, case_id, dump_id, detail_json) VALUES (?, ?, 'AcceptDump', ?, ?, ?, '{}')").run(EVENT_ID, NOW, CUSTOMER_ID, CASE_ID, DUMP_ID);

        const tables = ["customers", "cases", "upload_grants", "dumps", "audit_events"] as const;
        // customer_no is the one additive exception: migration 10 backfills it
        // into pre-existing customer rows, so the comparison strips it and the
        // backfill is asserted separately below.
        const stripCustomerNo = (table: string, row: unknown): unknown =>
          table === "customers" && typeof row === "object" && row !== null
            ? Object.fromEntries(Object.entries(row as Record<string, unknown>).filter(([key]) => key !== "customer_no"))
            : row;
        const seedRows = (): ReadonlyArray<{ readonly table: string; readonly rows: readonly unknown[] }> =>
          tables.map(table => ({ table, rows: database.prepare(`SELECT * FROM ${table} ORDER BY 1`).all().map(row => stripCustomerNo(table, row)) }));
        const before = seedRows();
        assert.deepEqual(versionList(database), [1, 2, 3, 4, 5, 6, 7]);

        applyMigrations(database);

        assert.deepEqual(versionList(database), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
        assert.deepEqual(seedRows(), before, "prior rows survive migrations 8-10 unchanged");
        assert.equal(
          (database.prepare("SELECT customer_no FROM customers WHERE customer_id = ?").get(CUSTOMER_ID) as { customer_no: number }).customer_no,
          1,
          "migration 10 backfills the display number",
        );
        assert.deepEqual(
          database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'dump_analyses_dump_idx'").all(),
          [{ name: "dump_analyses_dump_idx" }],
        );

        const insertAnalysis = (analysisId: string, dumpId: string): void => {
          database.prepare("INSERT INTO dump_analyses(analysis_id, dump_id, analyzer_name, analyzer_version, kind, input_sha256, outcome, summary, facts_json, duplicate_of, created_at) VALUES (?, ?, ?, ?, ?, ?, 'completed', 'ok', ?, NULL, ?)")
            .run(analysisId, dumpId, ANALYZER.name, ANALYZER.version, "triage", SHA, JSON.stringify({ answer: 42 }), NOW);
        };
        insertAnalysis(ANALYSIS_ID, DUMP_ID);
        assert.throws(() => insertAnalysis("analysis_00000000000000000000000002", DUMP_ID), /UNIQUE constraint failed/);
        assert.throws(() => insertAnalysis("analysis_00000000000000000000000003", "dump_00000000000000000000000099"), /FOREIGN KEY constraint failed/);
        assert.throws(
          () => database.prepare("INSERT INTO dump_analyses(analysis_id, dump_id, analyzer_name, analyzer_version, kind, input_sha256, outcome, summary, facts_json, duplicate_of, created_at) VALUES (?, ?, ?, ?, ?, ?, 'maybe', 'ok', NULL, NULL, ?)")
            .run("analysis_00000000000000000000000004", DUMP_ID, ANALYZER.name, ANALYZER.version, "triage", SHA, NOW),
          /CHECK constraint failed/,
        );
        assert.deepEqual(database.pragma("foreign_key_check"), []);
        assert.deepEqual(database.pragma("integrity_check"), [{ integrity_check: "ok" }]);
      } finally {
        database.close();
      }
      // The production ledger boots the migrated file and reads the stored report.
      const ledger = new SqliteLedger(databasePath);
      try {
        assert.equal(ledger.getDump(parseDumpId(DUMP_ID))?.sha256, SHA);
        const reports = ledger.listAnalyses(parseDumpId(DUMP_ID));
        assert.deepEqual(reports.map(report => report.analysisId), [ANALYSIS_ID]);
        assert.deepEqual(reports[0]?.facts, { answer: 42 });
      } finally {
        ledger.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function richCommand(dumpId: DumpId, request: RecordRichAnalysisRequest): LifecycleCommand {
  return { type: "RecordAnalysis", dumpId, analyzerName: request.analyzer.name, analyzerVersion: request.analyzer.version, kind: request.kind, inputSha256: request.inputSha256, outcome: request.outcome, summary: request.summary, facts: request.facts!, detail: { reportJson: request.reportJson, reportDigest: request.reportDigest } };
}

describe("canonical analysis persistence", () => {
  it("stores exact bytes, replays ACK loss, and purges summary plus detail", () => withEngine(({ engine, vault }) => {
    const dumpId = createAvailableDump(engine, vault), { request } = richFixture(dumpId, SHA), command = richCommand(dumpId, request);
    const first = engine.execute(command); assert.ok(first.ok && first.analysis !== undefined && !first.replayed);
    assert.deepEqual(engine.analysisDetail(dumpId, first.analysis.analysisId), { reportJson: request.reportJson, reportDigest: request.reportDigest });
    const replay = engine.execute(command); assert.ok(replay.ok && replay.replayed && replay.analysis?.analysisId === first.analysis.analysisId);
    assert.equal(engine.readAuditEvents(0, { actions: ["RecordAnalysis"] }).events.length, 1);
    assert.ok(engine.execute({ type: "BeginPurge", dumpId }).ok); assert.ok(engine.execute({ type: "FinishPurge", dumpId }).ok);
    assert.equal(engine.analysisDetail(dumpId, first.analysis.analysisId), null); assert.deepEqual(engine.listAnalyses(dumpId), []);
  }));
  it("promotes only digest-bound matching summary under its original analysis ID", () => withEngine(({ engine, vault }) => {
    const dumpId = createAvailableDump(engine, vault), { request } = richFixture(dumpId, SHA), command = richCommand(dumpId, request);
    const { detail: _detail, ...summary } = command as Extract<LifecycleCommand, { type: "RecordAnalysis" }>;
    const first = engine.execute(summary); assert.ok(first.ok && first.analysis !== undefined);
    assert.equal(engine.analysisDetail(dumpId, first.analysis.analysisId), null);
    const attached = engine.execute(command); assert.ok(attached.ok && attached.analysis?.analysisId === first.analysis.analysisId);
    const replay = engine.execute(command); assert.ok(replay.ok && replay.replayed);
    assert.equal(engine.listAnalyses(dumpId).length, 1);
    assert.equal(engine.readAuditEvents(0, { actions: ["AttachAnalysisDetail"] }).events.length, 1);
    const changed = richFixture(dumpId, SHA); changed.document.completeness = { omissions: ["Changed"], truncated: false };
    const conflict = engine.execute(richCommand(dumpId, bindRichFixture(changed.document))); assert.ok(!conflict.ok && conflict.error.code === "invalid_transition");
  }));
  it("rejects unbound legacy promotion, bad digest, wrong stable ID, and forged confirmed cause", () => withEngine(({ engine, vault }) => {
    const dumpId = createAvailableDump(engine, vault), { request } = richFixture(dumpId, SHA), command = richCommand(dumpId, request);
    const { detail: _detail, ...summary } = command as Extract<LifecycleCommand, { type: "RecordAnalysis" }>;
    assert.ok(engine.execute({ ...summary, facts: {} }).ok);
    const conflict = engine.execute(command); assert.ok(!conflict.ok && conflict.error.code === "invalid_transition");
    const badDigest = engine.execute({ ...summary, detail: { reportJson: request.reportJson, reportDigest: "b".repeat(64) } }); assert.ok(!badDigest.ok && badDigest.error.code === "invalid_input");
    const confirmed = richFixture(dumpId, SHA); (confirmed.document.rootCause as Record<string, unknown>).status = "confirmed";
    const confirmedResult = engine.execute(richCommand(dumpId, bindRichFixture(confirmed.document))); assert.ok(!confirmedResult.ok && confirmedResult.error.code === "invalid_input");
    const reportId = `r2_${"0".repeat(64)}`, reportJson = request.reportJson.replace(/r2_[0-9a-f]{64}/, reportId), reportDigest = createHash("sha256").update(reportJson).digest("hex");
    const badId = engine.execute(richCommand(dumpId, { ...request, reportJson, reportDigest, facts: { ...request.facts, reportId, reportDigest } })); assert.ok(!badId.ok && badId.error.code === "invalid_input");
  }));
  it("rolls back summary and audit when detail persistence fails", () => withEngine(({ engine, vault, databasePath }) => {
    const dumpId = createAvailableDump(engine, vault), { request } = richFixture(dumpId, SHA), db = new BetterSqlite3(databasePath);
    db.exec("CREATE TRIGGER reject_detail BEFORE INSERT ON analysis_details BEGIN SELECT RAISE(ABORT, 'injected failure'); END;");
    const failed = engine.execute(richCommand(dumpId, request)); assert.ok(!failed.ok);
    assert.deepEqual(engine.listAnalyses(dumpId), []); assert.equal(engine.readAuditEvents(0, { actions: ["RecordAnalysis"] }).events.length, 0);
    db.exec("DROP TRIGGER reject_detail"); db.close();
    const retry = engine.execute(richCommand(dumpId, request)); assert.ok(retry.ok);
  }));
});
