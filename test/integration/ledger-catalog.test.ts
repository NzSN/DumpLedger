import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import BetterSqlite3 from "better-sqlite3";

import {
  parseAuditEventId,
  parseCaseId,
  parseCustomerId,
  parseDumpId,
  parseGrantId,
  type AuditEventId,
  type CaseId,
  type CustomerId,
  type DumpId,
  type GrantId,
} from "../../src/domain/ids.js";
import { applyMigrations } from "../../src/ledger/migrations.js";
import { MAX_CATALOG_PAGE, SqliteLedger, type DumpCatalogFilter, type DumpCatalogRow } from "../../src/ledger/sqlite-ledger.js";

/**
 * Integration coverage for the ledger half of the dump catalog
 * (docs/analyzer-integration-design.md, "Dump catalog search"): migration 7,
 * keyset paging, the filter matrix, and the stored-inspector-fact mapping.
 * Runs against a real SQLite ledger in a temp directory and drives rows
 * through the lifecycle so their shape matches production, including the
 * decimal-string 64-bit inspector facts written by the vault inspection port.
 */

const BASE = "2026-09-01T00:00:00.000Z";
const PAGE_BASE = "2026-10-01T00:00:00.000Z";
const NOW = "2026-09-30T00:00:00.000Z";
const EXPIRY = "2027-01-01T00:00:00.000Z";

const body = (value: number): string => value.toString(10).padStart(26, "0");
const customerId = (value: number): CustomerId => parseCustomerId(`customer_${body(value)}`);
const caseId = (value: number): CaseId => parseCaseId(`case_${body(value)}`);
const grantId = (value: number): GrantId => parseGrantId(`grant_${body(value)}`);
const dumpId = (value: number): DumpId => parseDumpId(`dump_${body(value)}`);
const shaFor = (value: number): string => value.toString(16).padStart(64, "0");

let eventCounter = 0;
function event(at: string): { readonly eventId: AuditEventId; readonly occurredAt: string } {
  eventCounter += 1;
  return { eventId: parseAuditEventId(`audit_${body(eventCounter)}`), occurredAt: at };
}

const at = (seconds: number): string => new Date(Date.parse(BASE) + seconds * 1000).toISOString();
const pageAt = (seconds: number): string => new Date(Date.parse(PAGE_BASE) + seconds * 1000).toISOString();

function withLedger(run: (ledger: SqliteLedger) => void, prefix: string): void {
  const root = mkdtempSync(join(tmpdir(), prefix));
  try {
    const ledger = new SqliteLedger(join(root, "ledger.sqlite"));
    try {
      run(ledger);
    } finally {
      ledger.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function expectIds(rows: readonly DumpCatalogRow[], expected: readonly number[]): void {
  assert.deepEqual(rows.map(row => row.dumpId), expected.map(dumpId));
}

interface Matrix {
  readonly customer1: CustomerId;
  readonly customer2: CustomerId;
  readonly case1: CaseId;
  readonly case2: CaseId;
  readonly case3: CaseId;
}

/** Seeds ten dumps spanning customers, cases, phases, validations, received
 * timestamps, architectures, exception codes, and digests. */
function seedMatrix(ledger: SqliteLedger): Matrix {
  const customer1 = customerId(1);
  const customer2 = customerId(2);
  const case1 = caseId(1);
  const case2 = caseId(2);
  const case3 = caseId(3);
  ledger.createCustomer(customer1, "Acme", event(at(0)));
  ledger.createCustomer(customer2, "Globex", event(at(0)));
  ledger.createCase(case1, customer1, "Renderer crash", event(at(0)));
  ledger.createCase(case2, customer1, "GPU crash", event(at(0)));
  ledger.createCase(case3, customer2, "Startup crash", event(at(0)));
  const grant1 = grantId(1);
  const grant2 = grantId(2);
  const grant3 = grantId(3);
  ledger.issueGrant(grant1, case1, "secret-1", EXPIRY, 1_000_000n, 16, event(at(0)));
  ledger.issueGrant(grant2, case2, "secret-2", EXPIRY, 1_000_000n, 16, event(at(0)));
  ledger.issueGrant(grant3, case3, "secret-3", EXPIRY, 1_000_000n, 16, event(at(0)));

  // d1: still receiving; no bytes or digest recorded yet.
  ledger.beginUpload(grant1, dumpId(1), "crash-1.dmp", event(at(1)));
  // d2: sealed.
  ledger.beginUpload(grant1, dumpId(2), "crash-2.dmp", event(at(2)));
  ledger.sealUpload(dumpId(2), 2_000n, shaFor(2), event(at(2)));
  // d3: quarantined.
  ledger.beginUpload(grant1, dumpId(3), "crash-3.dmp", event(at(3)));
  ledger.sealUpload(dumpId(3), 3_000n, shaFor(3), event(at(3)));
  ledger.recordPromoted(dumpId(3), event(at(3)));
  ledger.markQuarantined(dumpId(3), event(at(3)));
  // d4/d5: available, sharing stored bytes and the same x86_64 exception facts.
  const factsX86 = { architecture: "x86_64", exceptionCode: "3221225477", exceptionAddress: "140695802675200" };
  ledger.beginUpload(grant1, dumpId(4), "crash-4.dmp", event(at(4)));
  ledger.sealUpload(dumpId(4), 4_000n, shaFor(45), event(at(4)));
  ledger.recordPromoted(dumpId(4), event(at(4)));
  ledger.markQuarantined(dumpId(4), event(at(4)));
  ledger.acceptDump(dumpId(4), "partial", factsX86, event(at(4)));
  ledger.setRetention(dumpId(4), at(20), event(at(4)));
  ledger.beginUpload(grant2, dumpId(5), "crash-5.dmp", event(at(5)));
  ledger.sealUpload(dumpId(5), 5_000n, shaFor(45), event(at(5)));
  ledger.recordPromoted(dumpId(5), event(at(5)));
  ledger.markQuarantined(dumpId(5), event(at(5)));
  ledger.acceptDump(dumpId(5), "partial", { ...factsX86, exceptionAddress: "140695802680000" }, event(at(5)));
  // d6: available, arm64 with a different exception code.
  ledger.beginUpload(grant2, dumpId(6), "crash-6.dmp", event(at(6)));
  ledger.sealUpload(dumpId(6), 6_000n, shaFor(6), event(at(6)));
  ledger.recordPromoted(dumpId(6), event(at(6)));
  ledger.markQuarantined(dumpId(6), event(at(6)));
  ledger.acceptDump(dumpId(6), "unknown", { architecture: "arm64", exceptionCode: "2147483651" }, event(at(6)));
  // d7: rejected by inspection; bytes stay sealed.
  ledger.beginUpload(grant3, dumpId(7), "crash-7.dmp", event(at(7)));
  ledger.sealUpload(dumpId(7), 7_000n, shaFor(7), event(at(7)));
  ledger.recordPromoted(dumpId(7), event(at(7)));
  ledger.markQuarantined(dumpId(7), event(at(7)));
  ledger.rejectDump(dumpId(7), "malformed-stream: exception stream is truncated", event(at(7)));
  // d8: interrupted transfer; no bytes or digest recorded.
  ledger.beginUpload(grant3, dumpId(8), "crash-8.dmp", event(at(8)));
  ledger.failUpload(dumpId(8), event(at(8)));
  // d9: available, inspection succeeded without architecture/exception facts.
  ledger.beginUpload(grant1, dumpId(9), "crash-9.dmp", event(at(9)));
  ledger.sealUpload(dumpId(9), 9_000n, shaFor(9), event(at(9)));
  ledger.recordPromoted(dumpId(9), event(at(9)));
  ledger.markQuarantined(dumpId(9), event(at(9)));
  ledger.acceptDump(dumpId(9), "partial", {}, event(at(9)));
  // d10: purged after acceptance; stored facts stay readable.
  ledger.beginUpload(grant3, dumpId(10), "crash-10.dmp", event(at(10)));
  ledger.sealUpload(dumpId(10), 10_000n, shaFor(10), event(at(10)));
  ledger.recordPromoted(dumpId(10), event(at(10)));
  ledger.markQuarantined(dumpId(10), event(at(10)));
  ledger.acceptDump(dumpId(10), "partial", factsX86, event(at(10)));
  ledger.setRetention(dumpId(10), at(21), event(at(10)));
  ledger.beginPurge(dumpId(10), event(at(10)));
  ledger.finishPurge(dumpId(10), event(at(10)));
  return { customer1, customer2, case1, case2, case3 };
}

describe("ledger catalog reads", () => {
  it("applies every filter alone and combined and maps stored inspector facts", () => {
    withLedger(ledger => {
      const { customer1, customer2, case1, case2 } = seedMatrix(ledger);
      const search = (filter: DumpCatalogFilter) => ledger.searchDumps(filter);

      const all = search({});
      expectIds(all.rows, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      assert.equal(all.nextAfter, undefined);

      expectIds(search({ caseId: case1 }).rows, [1, 2, 3, 4, 9]);
      expectIds(search({ customerId: customer1 }).rows, [1, 2, 3, 4, 5, 6, 9]);
      expectIds(search({ customerId: customer2 }).rows, [7, 8, 10]);

      expectIds(search({ phase: "receiving" }).rows, [1]);
      expectIds(search({ phase: "sealed" }).rows, [2]);
      expectIds(search({ phase: "quarantined" }).rows, [3]);
      expectIds(search({ phase: "available" }).rows, [4, 5, 6, 9]);
      expectIds(search({ phase: "rejected" }).rows, [7, 8]);
      expectIds(search({ phase: "deleted" }).rows, [10]);

      expectIds(search({ validation: "not-checked" }).rows, [1, 2, 3]);
      expectIds(search({ validation: "valid" }).rows, [4, 5, 6, 9, 10]);
      expectIds(search({ validation: "invalid" }).rows, [7]);
      expectIds(search({ validation: "transfer-failed" }).rows, [8]);

      // Received bounds are inclusive on both ends.
      expectIds(search({ receivedAfter: at(4) }).rows, [4, 5, 6, 7, 8, 9, 10]);
      expectIds(search({ receivedBefore: at(4) }).rows, [1, 2, 3, 4]);
      expectIds(search({ receivedAfter: at(4), receivedBefore: at(6) }).rows, [4, 5, 6]);

      expectIds(search({ architecture: "x86_64" }).rows, [4, 5, 10]);
      expectIds(search({ architecture: "arm64" }).rows, [6]);
      expectIds(search({ architecture: "no-such-arch" }).rows, []);
      expectIds(search({ exceptionCode: 0xc0000005 }).rows, [4, 5, 10]);
      expectIds(search({ exceptionCode: 0x80000003 }).rows, [6]);
      expectIds(search({ exceptionCode: 0xdeadbeef }).rows, []);

      expectIds(search({ sha256: shaFor(45) }).rows, [4, 5]);
      expectIds(search({ sha256: shaFor(6) }).rows, [6]);
      expectIds(search({ sha256: "f".repeat(64) }).rows, []);

      expectIds(search({ caseId: case1, phase: "available" }).rows, [4, 9]);
      expectIds(search({ caseId: case2, sha256: shaFor(45) }).rows, [5]);
      expectIds(search({ customerId: customer2, validation: "invalid" }).rows, [7]);
      expectIds(
        search({ customerId: customer1, architecture: "x86_64", exceptionCode: 0xc0000005, receivedAfter: at(4), receivedBefore: at(6) }).rows,
        [4, 5],
      );

      // Full row shape, including decimal-string facts mapped to number/bigint.
      const available = search({ caseId: case1, sha256: shaFor(45) }).rows[0];
      assert.ok(available !== undefined);
      assert.deepEqual(available, {
        dumpId: dumpId(4), caseId: case1, customerId: customer1,
        phase: "available", validation: "valid", originalName: "crash-4.dmp",
        byteSize: 4_000n, sha256: shaFor(45), receivedAt: at(4), availableAt: at(4), purgeAt: at(20),
        architecture: "x86_64", exceptionCode: 3_221_225_477, exceptionAddress: 140_695_802_675_200n,
      });

      // A successful inspection without the facts omits exactly those fields.
      const plain = search({ caseId: case1, sha256: shaFor(9) }).rows[0];
      assert.ok(plain !== undefined);
      assert.equal("architecture" in plain, false);
      assert.equal("exceptionCode" in plain, false);
      assert.equal("exceptionAddress" in plain, false);

      // Null discipline before the upload is sealed and before acceptance.
      const receiving = search({ phase: "receiving" }).rows[0];
      assert.ok(receiving !== undefined);
      assert.deepEqual(
        { byteSize: receiving.byteSize, sha256: receiving.sha256, availableAt: receiving.availableAt, purgeAt: receiving.purgeAt },
        { byteSize: null, sha256: null, availableAt: null, purgeAt: null },
      );

      // By-digest lookup is exact and catalog-ordered.
      assert.deepEqual(ledger.findDumpsBySha256(shaFor(45)).map(row => row.dumpId), [dumpId(4), dumpId(5)]);
      assert.deepEqual(ledger.findDumpsBySha256("f".repeat(64)), []);

      // Keyset on a short page, and the empty page beyond the end.
      expectIds(ledger.searchDumps({}, { receivedAt: at(3), dumpId: dumpId(3) }).rows, [4, 5, 6, 7, 8, 9, 10]);
      assert.equal(ledger.searchDumps({}, { receivedAt: at(3), dumpId: dumpId(3) }).nextAfter, undefined);
      const beyond = ledger.searchDumps({}, { receivedAt: at(10), dumpId: dumpId(10) });
      assert.deepEqual(beyond.rows, []);
      assert.equal(beyond.nextAfter, undefined);
    }, "dump-ledger-catalog-matrix-");
  });

  it("pages the catalog by keyset across 200-row pages with intake interleaved between fetches", () => {
    withLedger(ledger => {
      const customer = customerId(1);
      const supportCase = caseId(1);
      ledger.createCustomer(customer, "Acme", event(pageAt(0)));
      ledger.createCase(supportCase, customer, "Crash", event(pageAt(0)));
      const seed = (index: number, receivedAt: string): void => {
        const id = dumpId(index);
        const grant = grantId(index);
        ledger.issueGrant(grant, supportCase, `secret-${index}`, EXPIRY, 1_000_000n, 1, event(receivedAt));
        ledger.beginUpload(grant, id, `crash-${index}.dmp`, event(receivedAt));
        ledger.sealUpload(id, BigInt(index), shaFor(index), event(receivedAt));
        ledger.recordPromoted(id, event(receivedAt));
        ledger.markQuarantined(id, event(receivedAt));
        ledger.acceptDump(id, "partial", {}, event(receivedAt));
      };
      // 1..100 distinct timestamps; 101..300 share one timestamp (200 rows, so
      // the page boundary lands inside the tie group); 301..425 distinct again.
      for (let index = 1; index <= 100; index += 1) seed(index, pageAt(index));
      for (let index = 101; index <= 300; index += 1) seed(index, pageAt(100));
      for (let index = 301; index <= 425; index += 1) seed(index, pageAt(index - 200));

      const page1 = ledger.searchDumps({});
      assert.equal(page1.rows.length, MAX_CATALOG_PAGE);
      assert.deepEqual(page1.nextAfter, { receivedAt: pageAt(100), dumpId: dumpId(200) });

      // Intake interleaves with deep pagination: one dump behind the cursor is
      // never redelivered, and one sharing the boundary timestamp sorts into
      // the remaining pages exactly once.
      seed(902, pageAt(50));
      seed(900, pageAt(100));
      const page2 = ledger.searchDumps({}, page1.nextAfter);
      assert.equal(page2.rows.length, MAX_CATALOG_PAGE);
      assert.deepEqual(page2.nextAfter, { receivedAt: pageAt(199), dumpId: dumpId(399) });

      seed(901, pageAt(1000));
      seed(903, pageAt(2000));
      const page3 = ledger.searchDumps({}, page2.nextAfter);
      assert.equal(page3.rows.length, 28);
      assert.equal(page3.nextAfter, undefined);

      const delivered = [...page1.rows, ...page2.rows, ...page3.rows];
      assert.equal(delivered.length, 425 + 3);
      for (let index = 1; index < delivered.length; index += 1) {
        const previous = delivered[index - 1];
        const current = delivered[index];
        assert.ok(previous !== undefined && current !== undefined);
        assert.ok(
          previous.receivedAt < current.receivedAt || (previous.receivedAt === current.receivedAt && previous.dumpId < current.dumpId),
          `catalog order broke between ${previous.dumpId} and ${current.dumpId}`,
        );
      }
      const unique = new Set(delivered.map(row => row.dumpId));
      assert.equal(unique.size, delivered.length);
      for (let index = 1; index <= 425; index += 1) assert.ok(unique.has(dumpId(index)), `dump ${index} was delivered`);
      assert.ok(unique.has(dumpId(900)) && unique.has(dumpId(901)) && unique.has(dumpId(903)));
      // Keyset cursors are not snapshots: the behind-cursor insert is skipped.
      assert.equal(unique.has(dumpId(902)), false);

      const last = delivered[delivered.length - 1];
      assert.ok(last !== undefined);
      const beyond = ledger.searchDumps({}, { receivedAt: last.receivedAt, dumpId: last.dumpId });
      assert.deepEqual(beyond.rows, []);
      assert.equal(beyond.nextAfter, undefined);
    }, "dump-ledger-catalog-paging-");
  });

  it("reads inspector facts only when the stored inspection succeeded", () => {
    withLedger(ledger => {
      const customer = customerId(1);
      const supportCase = caseId(1);
      const begun = event(NOW);
      ledger.beginImport(begun, {});
      ledger.importCustomer({ customerId: customer, displayName: "Acme", createdAt: NOW }, event(NOW));
      ledger.importCase({ caseId: supportCase, customerId: customer, title: "Crash", status: "new", createdAt: NOW }, event(NOW));
      ledger.importDumpTombstone({
        dumpId: dumpId(1), caseId: supportCase, phase: "rejected", originalName: "failed.dmp",
        byteSize: 1_000n, sha256: shaFor(1), validation: "invalid", coverage: "partial",
        inspectionError: "malformed-stream: exception stream is truncated",
        inspectionFacts: { architecture: "x86_64", exceptionCode: "3221225477", exceptionAddress: "140695802675200" },
        receivedAt: at(1), availableAt: null, purgeAt: null, purgedAt: null,
      }, event(at(1)));
      ledger.importDumpTombstone({
        dumpId: dumpId(2), caseId: supportCase, phase: "rejected", originalName: "inspected.dmp",
        byteSize: 2_000n, sha256: shaFor(2), validation: "invalid", coverage: "partial",
        inspectionError: null,
        inspectionFacts: { architecture: "arm64", exceptionCode: "2147483651", exceptionAddress: "10" },
        receivedAt: at(2), availableAt: null, purgeAt: null, purgedAt: null,
      }, event(at(2)));
      ledger.finishImport(event(at(3)), begun.eventId, {});

      expectIds(ledger.searchDumps({ architecture: "x86_64" }).rows, []);
      expectIds(ledger.searchDumps({ exceptionCode: 0xc0000005 }).rows, []);
      expectIds(ledger.searchDumps({ architecture: "arm64" }).rows, [2]);
      expectIds(ledger.searchDumps({ exceptionCode: 0x80000003 }).rows, [2]);

      const flagged = ledger.searchDumps({}).rows.find(row => row.dumpId === dumpId(1));
      assert.ok(flagged !== undefined);
      assert.equal("architecture" in flagged, false);
      assert.equal("exceptionCode" in flagged, false);
      assert.equal("exceptionAddress" in flagged, false);

      const succeeded = ledger.searchDumps({}).rows.find(row => row.dumpId === dumpId(2));
      assert.ok(succeeded !== undefined);
      assert.deepEqual(
        { architecture: succeeded.architecture, exceptionCode: succeeded.exceptionCode, exceptionAddress: succeeded.exceptionAddress },
        { architecture: "arm64", exceptionCode: 2_147_483_651, exceptionAddress: 10n },
      );
    }, "dump-ledger-catalog-facts-");
  });

  it("migration 7 preserves version-6 rows and adds the catalog indexes on boot", () => {
    const root = mkdtempSync(join(tmpdir(), "dump-ledger-catalog-migration-"));
    const path = join(root, "ledger.sqlite");
    const customer = customerId(1);
    const supportCase = caseId(1);
    const dump = dumpId(1);
    const facts = { architecture: "x86_64", exceptionCode: "3221225477", exceptionAddress: "140695802675200" };
    try {
      const database = new BetterSqlite3(path);
      database.pragma("foreign_keys = ON");
      try {
        applyMigrations(database, 6);
        assert.deepEqual(
          database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('dumps_received_idx', 'dumps_sha256_idx')").all(),
          [],
        );
        database.prepare("INSERT INTO customers(customer_id, display_name, created_at) VALUES (?, ?, ?)").run(customer, "Acme", NOW);
        database.prepare("INSERT INTO cases(case_id, customer_id, title, status, created_at) VALUES (?, ?, ?, ?, ?)").run(supportCase, customer, "Crash", "new", NOW);
        database.prepare("INSERT INTO dumps(dump_id, case_id, phase, blob_state, original_name, byte_size, sha256, validation, coverage, downloadable, inspection_error, inspection_facts_json, received_at, available_at, purge_at, purged_at) VALUES (?, ?, 'available', 'vault', ?, ?, ?, 'valid', 'partial', 1, NULL, ?, ?, ?, NULL, NULL)")
          .run(dump, supportCase, "crash.dmp", "4096", shaFor(6), JSON.stringify(facts), NOW, NOW);
      } finally {
        database.close();
      }

      // Booting a ledger applies migration 7; the version-6 row stays readable.
      const ledger = new SqliteLedger(path);
      try {
        const page = ledger.searchDumps({ sha256: shaFor(6) });
        assert.equal(page.rows.length, 1);
        assert.deepEqual(page.rows[0], {
          dumpId: dump, caseId: supportCase, customerId: customer,
          phase: "available", validation: "valid", originalName: "crash.dmp",
          byteSize: 4_096n, sha256: shaFor(6), receivedAt: NOW, availableAt: NOW, purgeAt: null,
          architecture: "x86_64", exceptionCode: 3_221_225_477, exceptionAddress: 140_695_802_675_200n,
        });
        assert.deepEqual(ledger.findDumpsBySha256(shaFor(6)).map(row => row.dumpId), [dump]);
        assert.deepEqual(ledger.searchDumps({ architecture: "x86_64", exceptionCode: 0xc0000005 }).rows.map(row => row.dumpId), [dump]);
        assert.equal(ledger.getDump(dump)?.sha256, shaFor(6));
        assert.deepEqual(ledger.integrityCheck(), []);
      } finally {
        ledger.close();
      }

      const inspect = new BetterSqlite3(path, { readonly: true });
      try {
        assert.deepEqual(
          inspect.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('dumps_received_idx', 'dumps_sha256_idx') ORDER BY name").all(),
          [{ name: "dumps_received_idx" }, { name: "dumps_sha256_idx" }],
        );
        assert.deepEqual(
          (inspect.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>).map(row => row.version),
          [1, 2, 3, 4, 5, 6, 7, 8],
        );
      } finally {
        inspect.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
