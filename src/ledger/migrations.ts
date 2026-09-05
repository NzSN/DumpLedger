import type Database from "better-sqlite3";
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
];
export function applyMigrations(database: Database.Database): void {
  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT;`);
  const applied = new Set((database.prepare("SELECT version FROM schema_migrations").all() as Array<{version: number | bigint}>).map(row => Number(row.version)));
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    database.transaction(() => {
      database.exec(migration.sql);
      database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(migration.version, new Date().toISOString());
    })();
  }
}
