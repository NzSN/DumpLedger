import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import BetterSqlite3 from "better-sqlite3";

import { createDumpLedgerEngine, DeterministicClock, DeterministicEntropy, DeterministicIds, type ImportCounts } from "../../src/engine/dump-ledger-engine.js";
import type { CustomerId } from "../../src/domain/ids.js";
import { createHash } from "node:crypto";
import { SqliteLedger } from "../../src/ledger/sqlite-ledger.js";
import { MemoryVault } from "../../src/vault/memory-vault.js";
import type { InspectionPort } from "../../src/engine/dump-ledger-engine.js";

/**
 * Customer display numbers (#N): creation assigns the next instance-wide
 * number, migration 10 backfills creation-ordered numbers into existing
 * ledgers, and import preserves bundle-carried numbers (assigning the next
 * free number when a record lacks one).
 */

const GRANT_KEY = Uint8Array.from({ length: 32 }, () => 0x41);
const MANIFEST_DIGEST = createHash("sha256").update("manifest.json").digest("base64url");
const EMPTY_COUNTS: ImportCounts = { customers: 0, cases: 0, grants: 0, dumps: 0 };
const CUSTOMER_KEPT = `customer_${"0".repeat(25)}1` as CustomerId;
const CUSTOMER_FREE = `customer_${"0".repeat(25)}2` as CustomerId;
const okInspection: InspectionPort = { inspect: () => ({ ok: true, coverage: "partial", facts: {} }) };

function engineAt(clock: DeterministicClock) {
  return createDumpLedgerEngine({
    databasePath: ":memory:",
    vault: new MemoryVault(),
    inspection: okInspection,
    grantSecretKey: GRANT_KEY,
    clock,
    entropy: new DeterministicEntropy(["secret-a".repeat(8)]),
    ids: new DeterministicIds(),
  });
}

describe("customer display numbers", () => {
  it("assigns sequential numbers at creation and exposes them on the projection", () => {
    const engine = engineAt(new DeterministicClock("2026-10-01T00:00:00.000Z"));
    const first = engine.execute({ type: "CreateCustomer", displayName: "Acme Corp" });
    const second = engine.execute({ type: "CreateCustomer", displayName: "Globex Ltd" });
    assert.ok(first.ok && second.ok);
    assert.equal(first.customerNo, 1);
    assert.equal(second.customerNo, 2);
    const customers = engine.snapshot().customers;
    assert.deepEqual(customers.map(c => [c.displayName, c.customerNo]), [["Acme Corp", 1], ["Globex Ltd", 2]]);
  });

  it("migration 10 backfills creation-ordered numbers into a pre-10 ledger", () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-no-"));
    const path = join(dir, "ledger.sqlite");
    try {
      const db = new BetterSqlite3(path);
      db.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
               CREATE TABLE customers (customer_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;`);
      for (let v = 1; v <= 9; v += 1) db.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(v, "2026-09-01T00:00:00.000Z");
      // Valid legacy Crockford bodies, inserted so that id order and
      // creation order disagree: the earliest-created row has the largest id.
      db.prepare("INSERT INTO customers VALUES (?, ?, ?)").run(`customer_${"0".repeat(25)}1`, "Late Co", "2026-09-03T00:00:00.000Z");
      db.prepare("INSERT INTO customers VALUES (?, ?, ?)").run(`customer_${"Z".repeat(26)}`, "Early Co", "2026-09-01T00:00:00.000Z");
      db.prepare("INSERT INTO customers VALUES (?, ?, ?)").run(`customer_${"H".repeat(26)}`, "Mid Co", "2026-09-02T00:00:00.000Z");
      db.close();

      // Constructing the ledger applies migration 10; read the result with a
      // plain connection (snapshot() needs the full schema, which this
      // hand-built pre-10 fixture deliberately lacks).
      const ledger = new SqliteLedger(path);
      ledger.close();
      const check = new BetterSqlite3(path, { readonly: true });
      const rows = check.prepare("SELECT display_name, customer_no FROM customers").all() as Array<{ display_name: string; customer_no: number }>;
      const byName = new Map(rows.map(r => [r.display_name, r.customer_no]));
      assert.deepEqual([byName.get("Early Co"), byName.get("Mid Co"), byName.get("Late Co")], [1, 2, 3]);
      const indexes = check.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'customers_no_idx'").all();
      assert.equal(indexes.length, 1);
      check.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("import preserves bundle-carried numbers and assigns the next free number when absent", () => {
    const engine = engineAt(new DeterministicClock("2026-10-01T00:00:00.000Z"));
    assert.ok(engine.execute({ type: "BeginImport", manifestDigest: MANIFEST_DIGEST, counts: EMPTY_COUNTS }).ok);
    const kept = engine.execute({ type: "ImportCustomer", record: { customerId: CUSTOMER_KEPT, displayName: "Kept Co", createdAt: "2026-09-01T00:00:00.000Z", customerNo: 7 } });
    const assigned = engine.execute({ type: "ImportCustomer", record: { customerId: CUSTOMER_FREE, displayName: "Free Co", createdAt: "2026-09-02T00:00:00.000Z" } });
    assert.ok(kept.ok && assigned.ok);
    const byName = new Map(engine.snapshot().customers.map(c => [c.displayName, c.customerNo]));
    assert.equal(byName.get("Kept Co"), 7);
    assert.equal(byName.get("Free Co"), 8);
  });
});
