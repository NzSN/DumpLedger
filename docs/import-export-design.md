# Import/export design

Status: proposal. Implements the deferred "coordinated vault-byte backup,
restore verification, signed inventories, tombstone replay" (architecture,
Backup and restore status) and "local import" (implementation plan M5).

## Purpose and scope

Two operator-facing capabilities over one bundle format:

- **Export** — write a portable, self-describing bundle containing the SQLite
  ledger and the vault bytes for every dump in a stable lifecycle phase.
- **Import** — ingest a bundle produced by export into an instance, verifying
  every byte and re-establishing ledger rows through engine commands.

Primary use cases: moving an instance to a new host, coordinated backup/restore
drills, and evidence handoff. Per-case selective export and merge-import into a
non-empty instance are explicitly deferred (milestone IE4).

## Vocabulary

Per CONTEXT.md discipline, new domain terms are fixed here:

**Export bundle**:
A single tar archive with a manifest, a consistent SQLite ledger copy, and one
immutable object per exported dump.
_Avoid_: backup file, snapshot file

**Import**:
The verified ingestion of an export bundle into an instance. Imported dumps
re-enter the dump lifecycle at `available` (or `rejected`); no upload grant is
involved.
_Avoid_: restore upload

**Grant key fingerprint**:
A SHA-256 digest of the instance's grant-HMAC key published in the manifest so
import can decide whether outstanding grants remain honorably verifiable.
The key has at least 256 bits of entropy, so the digest is not a practical
preimage oracle.

## Bundle format

One uncompressed tar stream (dumps are incompressible binary; compression buys
nothing and costs CPU on multi-GB files). Layout:

```text
manifest.json            # dump-ledger.export-manifest/v1
ledger.sqlite            # consistent copy via SQLite online backup
vault/dump_<id>/original.dmp   # one entry per exported dump
```

`manifest.json`:

```json
{
  "schema": "dump-ledger.export-manifest/v1",
  "createdAt": "<iso>",
  "generator": { "version": "<app version>", "schemaMigrations": 2 },
  "grantKeyFingerprint": "<sha256 of grant key, base64url>",
  "counts": { "customers": 3, "cases": 5, "dumps": 11, "auditEvents": 87 },
  "skipped": [{ "dumpId": "dump_…", "phase": "receiving", "reason": "not-stable" }],
  "dumps": [
    { "dumpId": "dump_…", "caseId": "case_…", "phase": "available",
      "originalName": "crash.dmp", "byteSize": "73400320",
      "sha256": "<hex>", "entry": "vault/dump_…/original.dmp" }
  ]
}
```

- The manifest is bounded in size by the ledger row counts; it is the only JSON
  the importer trusts before verification, and only after schema decoding.
- Tar entries are written by a small internal `src/transfer/` tar writer/reader
  (512-byte headers, ustar subset). No new dependency: the format is trivial,
  we control both ends, and a third-party tar library would import a large
  untrusted-input surface for no benefit.
- Deterministic entry order (manifest, ledger, then dumps sorted by dump ID)
  makes exports comparable and test fixtures stable.

## Export pipeline

`src/transfer/export.ts`, driven from a new operations route:

1. **Snapshot the ledger** with the existing SQLite online backup
   (`engine.backup`) into a temporary file under `data/exports/<id>/`. The
   backup API gives a transactionally consistent DB without pausing writers.
2. **Select dumps** from `engine.snapshot()`: phases `available`, `rejected`,
   `deleted` are stable (vault bytes immutable or absent). Phases `receiving`,
   `sealed`, `quarantined`, `deleting` are recorded in `manifest.skipped` with
   their phase — a concurrent upload simply does not appear in this export.
3. **Stream the tar**: manifest first, then `ledger.sqlite`, then each dump's
   bytes through the vault reader, bounded by the recorded `byteSize`; a dump
   whose bytes vanish mid-copy (concurrent purge finishing) is dropped from the
   manifest and recorded as skipped — never a partial entry.
4. **Seal**: fsync the bundle, rename into `data/exports/<id>/bundle.tar`
   (same atomic-rename discipline as the vault), fsync the directory.
5. **Audit**: emit an `ExportCreated` audit event with counts and bundle ID.

Export files are sensitive (they contain full memory dumps). They live under
`data/exports/` on the same encrypted volume as the vault, are never served as
static content, and are listed/deletable from the operations page. Automatic
export expiry is IE4.

## Import pipeline

`src/transfer/import.ts`. Version 1 imports into an **empty ledger only**
(fresh instance or after a deliberate wipe); merge semantics are IE4.

1. **Pre-flight validation** of the tar as an untrusted container: reject
   absolute paths, `..` segments, symlinks/hardlinks/devices, duplicate names,
   and unknown top-level entries; bound entry count, total bytes, and manifest
   size before reading any of them. (Same posture as the minidump parser:
   checked arithmetic, bounded everything.)
2. **Manifest checks**: exact schema `dump-ledger.export-manifest/v1`;
   `generator.schemaMigrations` must be ≤ the running schema version (older
   bundles are migrated by replaying normal SQLite migrations after step 4).
3. **Grant key reconciliation**: compare `grantKeyFingerprint` with the running
   instance's key. On mismatch, every grant still in `issued` state is imported
   as `revoked` with an audit event — an imported grant secret must never
   become usable against a key it was not issued under.
4. **Ledger restore**: load `ledger.sqlite` into a temporary file, run
   `PRAGMA integrity_check` and the migration check, then copy rows into the
   live ledger inside one transaction per entity through new engine commands —
   never direct table writes from the transfer module.
5. **Byte verification and placement**: for each manifest dump, stream the tar
   entry through SHA-256 into the vault's **own staging/promote machinery**
   (`createStaging` → `append` → `syncAndClose` → `promote`). A hash or size
   mismatch imports the dump as `rejected` with the mismatch recorded; a match
   enters `available` (or keeps `rejected` if that was its exported phase).
6. **Audit**: `ImportStarted`, per-dump `ImportDumpAccepted/Rejected`, and
   `ImportFinished` with counts and the source manifest digest.

### New engine commands

Following the existing command pattern (`engine.execute({ type: … })` with
deterministic clock/ids injected):

```text
BeginImport(manifestDigest, counts)          -> importId + audit
ImportCustomer / ImportCase                  -> rows with preserved IDs
ImportGrant(record, forcedState?)            -> honors fingerprint policy
ImportDump(record, sha256Verified)           -> available | rejected (+audit)
FinishImport(importId, summary)              -> audit + completion marker
```

Preserving the original branded IDs keeps the audit trail continuous across
instances; random ULID/UUID-based IDs make cross-instance collisions negligible, which is
what makes merge (IE4) feasible later.

## Consistency and crash recovery

- Export never blocks intake in v1; immutability of vault objects plus
  phase-based selection gives a coherent, slightly-behind snapshot. A strict
  point-in-time export needs the deferred **intake pause** (IE4).
- Import crash safety reuses the existing reconciliation state machine:
  imported bytes sit in vault staging until promoted, so an interrupted import
  is cleaned up or resumed by the same startup reconciliation that handles
  interrupted uploads. Ledger rows are written per-entity in short
  transactions; `BeginImport`/`FinishImport` markers let reconciliation detect
  and report a half-finished import.
- The exported `ledger.sqlite` is a backup artifact of record: the manifest
  digest in `ImportFinished` closes the restore-verification loop the
  architecture doc requires.

## Security controls

- Both routes are operator-only behind `jsonRequireMutation` (session + CSRF +
  origin), rate-limited like other expensive operations.
- Export bundles and imports stay on the server filesystem; the UI triggers and
  monitors them but dump bytes never transit the browser during import (a
  multi-GB HTTP upload of a bundle is not a v1 goal).
- Import applies the minidump-parser threat posture to the tar itself
  (bounded, checked, no symlink following, no path escapes); imported dump
  bytes are additionally re-inspected by the normal inspection port before
  becoming `available`, exactly as if uploaded.
- The bundle contains the full ledger including grant digests and audit
  history: handle it with the same controls as `data/` (encrypted volume,
  restricted identity). The operator password hash is environment config and
  is never exported.
- Import/export of a case marked `closed` preserves its workflow status;
  closing-time grant revocation survives through the fingerprint policy.

## HTTP and UI surface

```text
POST /api/v1/operations/exports            -> { exportId }   (one at a time, 409 while running)
GET  /api/v1/operations/exports            -> bounded list with status/size/createdAt
GET  /api/v1/operations/exports/:id/file   -> streamed tar download (no buffering)
DELETE /api/v1/operations/exports/:id      -> remove bundle
POST /api/v1/operations/imports            -> { importId }   body: { path } (server-local bundle path)
GET  /api/v1/operations/imports/:id        -> progress: verified/imported/skipped counts
```

Contracts gain `dump-ledger.export-manifest/v1` decoders in
`@dump-ledger/http-contracts` (runtime-validated like everything else). The
operations page gains an "Export / Import" section with a strict-confirmation
dialog for import ("imports into an empty ledger only").

## Formal-model boundary

V1 keeps import/export **outside** `specs/DumpLedger.tla`: export reads a
consistent snapshot and import re-enters dumps through existing lifecycle
states, so the current `SafetyInvariant` statements are unaffected (imported
dumps satisfy `AvailableHasEvidence` by construction — bytes are verified
before the row reaches `available`). Extending the model with Import actions
and regenerating the model-interface/MBT artifacts is IE4 and must land as one
reviewed change, per the model-freshness discipline.

## Implementation milestones

**IE1 — bundle format and export**
- `src/transfer/tar.ts` writer + strict reader with unit tests (traversal,
  bounds, malformed headers);
- manifest schema + contracts decoders; export pipeline + engine audit events;
- operations routes + integration tests (export during concurrent upload and
  concurrent purge; interrupted export leaves no partial bundle).

**IE2 — import**
- engine import commands with deterministic injection and audit events;
- verification pipeline (sha256 streaming, vault staging reuse, re-inspection);
- empty-ledger guard, grant-fingerprint policy, migration replay;
- integration tests: round-trip (export → wipe → import → byte-identical
  download), tampered bytes rejected, wrong-key grants revoked, crash-failpoint
  import resumed by reconciliation.

**IE3 — UI and e2e**
- operations page section; Playwright journey covering IE2's round trip through
  the real bundle download/upload path.

**IE4 — hardening (deferred)**
- intake pause for strict point-in-time export; HMAC-signed manifest;
  per-case selective export; merge import with conflict policy; export expiry;
  optional passphrase encryption of bundles; TLA+ model extension.

## As-built adjustments (implementation waves A–B)

- **Audit action names** follow the command-name convention: `BeginImport`,
  `ImportCustomer`, `ImportCase`, `ImportGrant`, `ImportDumpStaged`,
  `ImportAuditEvent`, `FinishImport`. There is no separate
  `ExportCreated`/`ImportDumpAccepted/Rejected`; dump accept/reject reuses the
  existing `AcceptDump`/`RejectDump` audit events. (Export-side audit is a
  remaining gap, noted for IE4.)
- **Historical audit events are imported** (`ImportAuditEvent` command) so the
  trail survives migration; events referencing left-behind (skipped) dumps are
  dropped to preserve FK integrity.
- **Mid-copy purge race**: instead of dropping the dump from a
  already-streamed manifest, the export aborts as failed/retryable; no partial
  or sealed bundle survives.
- **Import is synchronous** in v1 (better-sqlite3/fs block the event loop on
  multi-GB bundles); the progress endpoint advances only between engine steps.
  Chunked/async import is IE4 hardening.
- **Skew guard**: snapshot selection vs. backup skew makes a bundle internally
  inconsistent; import refuses it with `integrity_failure` (conservative).

## Open questions

- Should export bundles embed the generator's software version for
  compatibility gating, or is `schemaMigrations` sufficient?
- Is per-case export (with its customer and case subgraph) the right handoff
  shape, or do support workflows actually need whole-instance archives only?
- Should import re-authenticate the operator (password prompt) given it
  replaces the entire ledger?
