import type Database from "better-sqlite3";
import { DumpLedgerError } from "../domain/errors.js";
interface Migration { readonly version: number; readonly sql: string }
const migrations: readonly Migration[] = [
  { version: 1, sql: `
    CREATE TABLE customers (customer_id TEXT PRIMARY KEY, display_name TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
    CREATE TABLE cases (case_id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(customer_id), title TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('new','investigating','waiting-for-customer','resolved','closed')), created_at TEXT NOT NULL) STRICT;
    CREATE TABLE upload_grants (grant_id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(case_id), secret_digest TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK (state IN ('issued','consumed','revoked','expired')), expires_at TEXT NOT NULL, max_bytes TEXT NOT NULL, consumed_by_dump_id TEXT, created_at TEXT NOT NULL) STRICT;
    CREATE TABLE dumps (
      dump_id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(case_id),
      phase TEXT NOT NULL CHECK (phase IN ('receiving','sealed','quarantined','available','rejected','deleting','deleted')),
      blob_state TEXT NOT NULL CHECK (blob_state IN ('staging','vault','none')), original_name TEXT NOT NULL,
      byte_size TEXT, sha256 TEXT, validation TEXT NOT NULL CHECK (validation IN ('not-checked','valid','invalid','transfer-failed')),
      coverage TEXT CHECK (coverage IS NULL OR coverage IN ('partial','full-memory-declared','unknown')),
      downloadable INTEGER NOT NULL CHECK (downloadable IN (0,1)), inspection_error TEXT, inspection_facts_json TEXT,
      received_at TEXT NOT NULL, available_at TEXT, purged_at TEXT
    ) STRICT;
    CREATE TABLE audit_events (event_id TEXT PRIMARY KEY, occurred_at TEXT NOT NULL, action TEXT NOT NULL, customer_id TEXT REFERENCES customers(customer_id), case_id TEXT REFERENCES cases(case_id), dump_id TEXT REFERENCES dumps(dump_id), detail_json TEXT NOT NULL) STRICT;
    CREATE TRIGGER dumps_case_immutable BEFORE UPDATE OF case_id ON dumps WHEN OLD.case_id <> NEW.case_id BEGIN SELECT RAISE(ABORT, 'dump case association is immutable'); END;
    CREATE TRIGGER grant_terminal_state_immutable BEFORE UPDATE OF state ON upload_grants WHEN OLD.state IN ('consumed','revoked','expired') AND NEW.state <> OLD.state BEGIN SELECT RAISE(ABORT, 'grant terminal state is immutable'); END;
    CREATE INDEX dumps_case_idx ON dumps(case_id);
    CREATE INDEX grants_case_idx ON upload_grants(case_id);
    CREATE INDEX audit_case_idx ON audit_events(case_id, occurred_at);
  ` },
  { version: 2, sql: `ALTER TABLE dumps ADD COLUMN purge_at TEXT; CREATE INDEX dumps_purge_due_idx ON dumps(purge_at, phase);` },
  /* Batch upload (docs/batch-upload-design.md): grants become multi-slot.
   * Existing rows take the defaults and keep exact one-time semantics. */
  { version: 3, sql: `
    ALTER TABLE upload_grants ADD COLUMN max_uploads INTEGER NOT NULL DEFAULT 1 CHECK (max_uploads BETWEEN 1 AND 16);
    ALTER TABLE upload_grants ADD COLUMN uploads_used INTEGER NOT NULL DEFAULT 0 CHECK (uploads_used BETWEEN 0 AND 16);
  ` },
  /* Symbol store (docs/symbols-design.md): module identities and immutable
   * symbol artifacts. Purely additive; identity is unique per kind. */
  { version: 4, sql: `
    CREATE TABLE modules (
      module_id TEXT PRIMARY KEY,
      debug_file TEXT NOT NULL,
      debug_id TEXT NOT NULL,
      product TEXT,
      version TEXT,
      arch TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (debug_file, debug_id)
    ) STRICT;
    CREATE TABLE symbol_artifacts (
      artifact_id TEXT PRIMARY KEY,
      module_id TEXT NOT NULL REFERENCES modules(module_id),
      kind TEXT NOT NULL CHECK (kind IN ('pdb')),
      byte_size TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (module_id, kind)
    ) STRICT;
    CREATE INDEX modules_identity_idx ON modules(debug_file, debug_id);
  ` },
  /* EXE artifact kind (docs/symbols-design.md, milestone 3; decision D2
   * lifted). A module row now carries either a debug identity (PDB) or a code
   * identity (PE image), so the debug columns become nullable and code_file/
   * code_id join the entity; the artifact CHECK admits a `pdb`/`exe` kind.
   * SQLite cannot drop a NOT NULL or widen a CHECK constraint in place, so both
   * tables are rebuilt and their rows copied (preservation covered by
   * test/unit/migrations.test.ts). UNIQUE treats NULLs as distinct, so each
   * identity constraint binds exactly the rows that carry it. */
  { version: 5, sql: `
    CREATE TABLE modules_rebuilt (
      module_id TEXT PRIMARY KEY,
      debug_file TEXT,
      debug_id TEXT,
      code_file TEXT,
      code_id TEXT,
      product TEXT,
      version TEXT,
      arch TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (debug_file, debug_id),
      UNIQUE (code_file, code_id)
    ) STRICT;
    INSERT INTO modules_rebuilt(module_id, debug_file, debug_id, code_file, code_id, product, version, arch, created_at)
      SELECT module_id, debug_file, debug_id, NULL, NULL, product, version, arch, created_at FROM modules;
    CREATE TABLE symbol_artifacts_rebuilt (
      artifact_id TEXT PRIMARY KEY,
      module_id TEXT NOT NULL REFERENCES modules(module_id),
      kind TEXT NOT NULL CHECK (kind IN ('pdb','exe')),
      byte_size TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE (module_id, kind)
    ) STRICT;
    INSERT INTO symbol_artifacts_rebuilt(artifact_id, module_id, kind, byte_size, sha256, created_at)
      SELECT artifact_id, module_id, kind, byte_size, sha256, created_at FROM symbol_artifacts;
    DROP TABLE symbol_artifacts;
    DROP TABLE modules;
    ALTER TABLE modules_rebuilt RENAME TO modules;
    ALTER TABLE symbol_artifacts_rebuilt RENAME TO symbol_artifacts;
    CREATE INDEX modules_identity_idx ON modules(debug_file, debug_id);
    CREATE INDEX modules_code_identity_idx ON modules(code_file, code_id);
  ` },
];
/**
 * Applies pending migrations in ascending version order, each inside its own
 * transaction. `throughVersion` exists for schema-version tests that need a
 * historical database state; production callers apply everything.
 */
export function applyMigrations(database: Database.Database, throughVersion: number = Number.POSITIVE_INFINITY): void {
  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT;`);
  const applied = new Set((database.prepare("SELECT version FROM schema_migrations").all() as Array<{version: number | bigint}>).map(row => Number(row.version)));
  const pending = migrations.filter(migration => migration.version <= throughVersion && !applied.has(migration.version));
  if (pending.length === 0) return;
  /* Table rebuilds (migration 5) drop a parent table while its rows still live
   * in the rebuilt child table, which foreign key enforcement rejects. The
   * documented rebuild procedure (SQLite: "Making Other Kinds Of Table Schema
   * Changes") runs with foreign keys off and verifies with foreign_key_check
   * once they are back on; `PRAGMA foreign_keys` is a no-op inside a
   * transaction, so the switch wraps the whole pending batch -- every migration
   * still commits in its own transaction. */
  database.pragma("foreign_keys = OFF");
  try {
    for (const migration of pending) {
      database.transaction(() => {
        database.exec(migration.sql);
        database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(migration.version, new Date().toISOString());
      })();
    }
  } finally {
    database.pragma("foreign_keys = ON");
  }
  const violations = database.pragma("foreign_key_check") as readonly unknown[];
  if (violations.length > 0) throw new DumpLedgerError("integrity_failure", `migrations left ${violations.length} foreign key violation(s)`);
}
