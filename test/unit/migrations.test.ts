import assert from "node:assert/strict";
import { test } from "node:test";

import BetterSqlite3 from "better-sqlite3";

import { applyMigrations } from "../../src/ledger/migrations.js";

/**
 * Migration 5 rebuilds `modules` and `symbol_artifacts` (docs/symbols-design.md,
 * milestone 3): the debug identity becomes nullable, the code identity joins
 * the module entity, and the artifact kind CHECK admits `pdb` and `exe`.
 * SQLite cannot drop a NOT NULL or widen a CHECK in place, so the migration
 * copies both tables into rebuilt ones and renames them back; this test builds
 * a genuine version-4 database through the migration list, fills it, applies
 * the remaining migration, and proves every stored row survived unchanged.
 */

const NOW = "2026-09-18T00:00:00.000Z";
const DEBUG_ID = "3A9C1F2E4B5D6789012345678ABCDEF1";
const SHA256 = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const CODE_ID = "5F3759DF20000";

test("migration 5 preserves version-4 module and artifact rows and admits the EXE kind", () => {
  const database = new BetterSqlite3(":memory:");
  try {
    database.pragma("foreign_keys = ON");
    applyMigrations(database, 4);

    // The version-4 shape: debug identity NOT NULL, PDB-only kind.
    database.prepare("INSERT INTO modules(module_id, debug_file, debug_id, product, version, arch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("module_A", "electron.pdb", DEBUG_ID, "Electron", "41.10.6", "x64", NOW);
    database.prepare("INSERT INTO modules(module_id, debug_file, debug_id, product, version, arch, created_at) VALUES (?, ?, ?, NULL, NULL, NULL, ?)")
      .run("module_B", "node.pdb", "ABCDEF0123456789ABCDEF01234567890", NOW);
    database.prepare("INSERT INTO symbol_artifacts(artifact_id, module_id, kind, byte_size, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("symbol_A", "module_A", "pdb", "2147483648", SHA256, NOW);
    database.prepare("INSERT INTO symbol_artifacts(artifact_id, module_id, kind, byte_size, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("symbol_B", "module_B", "pdb", "1024", SHA256, NOW);
    // Version 4 rejects the very states migration 5 lifts.
    assert.throws(
      () => database.prepare("INSERT INTO symbol_artifacts(artifact_id, module_id, kind, byte_size, sha256, created_at) VALUES (?, ?, 'exe', ?, ?, ?)")
        .run("symbol_X", "module_A", "1", SHA256, NOW),
      /CHECK constraint failed/,
    );
    assert.throws(
      () => database.prepare("INSERT INTO modules(module_id, debug_file, debug_id, created_at) VALUES (?, NULL, NULL, ?)")
        .run("module_X", NOW),
      /NOT NULL constraint failed/,
    );

    applyMigrations(database);

    assert.deepEqual(
      database.prepare("SELECT * FROM modules ORDER BY module_id").all(),
      [
        { module_id: "module_A", debug_file: "electron.pdb", debug_id: DEBUG_ID, code_file: null, code_id: null, product: "Electron", version: "41.10.6", arch: "x64", created_at: NOW },
        { module_id: "module_B", debug_file: "node.pdb", debug_id: "ABCDEF0123456789ABCDEF01234567890", code_file: null, code_id: null, product: null, version: null, arch: null, created_at: NOW },
      ],
    );
    assert.deepEqual(
      database.prepare("SELECT * FROM symbol_artifacts ORDER BY artifact_id").all(),
      [
        { artifact_id: "symbol_A", module_id: "module_A", kind: "pdb", byte_size: "2147483648", sha256: SHA256, created_at: NOW },
        { artifact_id: "symbol_B", module_id: "module_B", kind: "pdb", byte_size: "1024", sha256: SHA256, created_at: NOW },
      ],
    );
    assert.deepEqual(
      (database.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{ version: number }>).map(row => row.version),
      [1, 2, 3, 4, 5],
    );

    // The rebuilt shape admits a code identity: an EXE module carries NULL
    // debug columns (UNIQUE treats the NULLs as distinct) and an `exe` artifact.
    assert.deepEqual(
      database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('modules_identity_idx', 'modules_code_identity_idx') ORDER BY name").all(),
      [{ name: "modules_code_identity_idx" }, { name: "modules_identity_idx" }],
    );
    database.prepare("INSERT INTO modules(module_id, code_file, code_id, created_at) VALUES (?, ?, ?, ?)").run("module_C", "electron.exe", CODE_ID, NOW);
    database.prepare("INSERT INTO modules(module_id, code_file, code_id, created_at) VALUES (?, ?, ?, ?)").run("module_D", "node.dll", "12345678ABC", NOW);
    database.prepare("INSERT INTO symbol_artifacts(artifact_id, module_id, kind, byte_size, sha256, created_at) VALUES (?, ?, 'exe', ?, ?, ?)").run("symbol_C", "module_C", "4096", SHA256, NOW);
    assert.deepEqual(
      database.prepare("SELECT module_id, debug_file, code_file, code_id FROM modules WHERE module_id = 'module_C'").get(),
      { module_id: "module_C", debug_file: null, code_file: "electron.exe", code_id: CODE_ID },
    );
    // Both rebuilt tables are still STRICT: a BLOB cannot enter a TEXT column
    // (a non-STRICT table would store it), and the DDL keeps its marker.
    assert.throws(
      () => database.prepare("INSERT INTO symbol_artifacts(artifact_id, module_id, kind, byte_size, sha256, created_at) VALUES (?, ?, 'pdb', ?, ?, ?)")
        .run("symbol_Y", "module_C", Buffer.from("not text"), SHA256, NOW),
      /cannot store BLOB value in TEXT column/,
    );
    for (const table of ["modules", "symbol_artifacts"]) {
      const ddl = (database.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(table) as { sql: string }).sql;
      assert.match(ddl, /STRICT/);
    }

    // The rebuild procedure verifies its own foreign keys, and purge-style
    // child-first deletion still respects the module reference.
    assert.deepEqual(database.pragma("foreign_key_check"), []);
    assert.deepEqual(database.pragma("integrity_check"), [{ integrity_check: "ok" }]);
    assert.throws(
      () => database.prepare("DELETE FROM modules WHERE module_id = ?").run("module_A"),
      /FOREIGN KEY constraint failed/,
    );
  } finally {
    database.close();
  }
});

test("an existing version-5 database is left untouched by a second boot", () => {
  const database = new BetterSqlite3(":memory:");
  try {
    database.pragma("foreign_keys = ON");
    applyMigrations(database);
    database.prepare("INSERT INTO modules(module_id, code_file, code_id, created_at) VALUES (?, ?, ?, ?)").run("module_C", "electron.exe", CODE_ID, NOW);
    database.prepare("INSERT INTO symbol_artifacts(artifact_id, module_id, kind, byte_size, sha256, created_at) VALUES (?, ?, 'exe', ?, ?, ?)").run("symbol_C", "module_C", "4096", SHA256, NOW);
    assert.equal(database.pragma("foreign_keys", { simple: true }), 1);
    applyMigrations(database);
    assert.deepEqual(
      database.prepare("SELECT artifact_id, kind FROM symbol_artifacts").all(),
      [{ artifact_id: "symbol_C", kind: "exe" }],
    );
    assert.deepEqual(database.pragma("foreign_key_check"), []);
  } finally {
    database.close();
  }
});
