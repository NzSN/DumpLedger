# Implementation plan and status

## Delivery rule

Each milestone ends with an executable acceptance gate. Later work must not
weaken the association, availability, or deletion invariants established by an
earlier milestone. “Implemented” below means code and focused automated tests
exist; it is not a claim that the complete product is formally verified or
ready for an internet-facing production deployment.

## Current implementation baseline

DumpLedger is implemented in strict TypeScript 7 and runs as one Node.js 24
process. Fastify serves the operator/uploader interface, `better-sqlite3` owns
the local metadata ledger, and dump bytes live in an immutable filesystem vault
on an operator-provided encrypted volume. The asynchronous upload pipeline is
kept outside the synchronous lifecycle engine.

The MBT acceptance path is checked-in ITF traces -> Mirrors verification ->
MirrorECMA negotiated runner -> compiler-generated binding/`StateComputer` ->
handwritten generated-port adapter -> real lifecycle engine. The generated
tree is compiler-owned. The synchronous `StateComputer` constraint forbids
promise-returning generated actions or observations.

## M0 — Design, model, and generated interface: partially revised

Previously delivered for the grant/dump lifecycle:

- product, architecture, security, formal-model, and implementation documents;
- compiler-compatible TLA+ lifecycle model and aggregate `SafetyInvariant`;
- model-interface contract, lock, coverage record, generated TypeScript port,
  and six checked-in Apalache witness traces;
- reproducible read-only model-interface checking and explicit trace
  regeneration tooling.

Pre-revision validation record from 2026-09-05:

- TLC: 3,837 generated states, 2,001 distinct states, depth 17, no invariant
  violation;
- Apalache 0.57.0: no `SafetyInvariant` counterexample through length 8;
- six traces: 47 total states and all 13 stable actions covered;
- semantic digest:
  `edefb258a6c1e4e2f8aa5103c468401b8a94125b8e51011653407e521fb10b45`.

These results cover a finite abstract model and finite trace corpus. They do not
prove byte-level, filesystem, database, HTTP, cryptographic, or deployment
behavior.

Specification-only case-workflow revision:

- `caseStatus` and five explicit case actions are now modeled;
- closing atomically revokes issued grants, and closed cases cannot issue a
  grant or begin an upload;
- `ClosedCaseHasNoIssuedGrant` is part of `SafetyInvariant`;
- TLC now explores 515,075 generated / 99,143 distinct states to depth 23 with
  no invariant violation;
- Apalache type checking and bounded `SafetyInvariant` checking through length
  8 pass.

Not implemented yet: runtime case commands, persistence transitions, HTTP/UI
controls, the `CaseStatus` generated observation, five generated case-action
handlers, refreshed lock/binding, MirrorECMA traces, and coverage. The existing
generated artifacts intentionally remain pinned to the pre-revision semantic
digest until those changes are implemented together.

## M1 — Lifecycle ledger and vault: implemented and tested

Delivered:

- branded identifiers and closed lifecycle commands;
- managed SQLite schema/migrations, immutable case association, one-way grant
  terminal states, short transactions, and audit rows;
- synchronous lifecycle engine with deterministic clock, entropy, IDs, and
  crash failpoints for tests;
- production filesystem vault plus shared in-memory vault contract adapter;
- exclusive staging, streaming SHA-256, sealing, atomic local promotion,
  quarantine, controlled download, and two-phase purge;
- startup reconciliation for receiving, sealed, quarantined, available,
  rejected, deleting, deleted, and aged orphan-staging states;
- case manifest, SQLite integrity check/backup, and metadata-only backup
  inventory.

Validated by unit/integration coverage for legal and illegal transitions,
grant/case integrity, vault contracts, path/symlink constraints, failpoints,
recovery, download gating, and retention/purge behavior.

Not delivered in this milestone: local operator file import, a coordinated
vault-byte backup, restore verification, signed inventories, or tombstone replay
against older backups.

## M2 — Minidump inspection: implemented with synthetic-fixture evidence

Delivered:

- synchronous bounded random-access parser over buffer and filesystem readers;
- `MDMP` header/version/directory checks and checked unsigned-64 arithmetic;
- capped stream, module, range, string, exception, and memory-info counts;
- `MemoryListStream`, `Memory64ListStream`, raw flags, descriptor-summed captured
  bytes, architecture, exception, and module facts;
- `partial`, `full-memory-declared`, and `unknown` classification;
- production vault-to-engine inspection bridge with JSON-safe bigint facts and
  stable parser failures.

Validated with deterministic small fixtures for partial/full/unknown,
truncation, malformed ranges, overflow, duplicate critical streams, count
limits, fact extraction, bounded reads, and filesystem-reader lifetime.
`MiniDumpWithFullMemoryInfo` alone does not yield
`full-memory-declared`.

Deferred acceptance work: a reviewed corpus of real Crashpad/DbgHelp dumps,
coverage across producer/version variants, continuous fuzzing, and a retained
fuzz-regression corpus. Current “valid” means format-consistent under the
implemented parser, not production-validated completeness.

## M3 — Remote one-time upload and web shell: implemented baseline

Delivered:

- local operator login/session and CSRF-protected mutation routes;
- customer/case creation, expiring one-time case-bound grants, upload-link page,
  streamed octet upload, case/dump pages, case manifest, retention assignment,
  controlled download, and basic operations health;
- content-length and streamed byte enforcement, configurable concurrent-upload
  admission, safe filename handling, and bounded post-processing retry queue;
- bounded fixed-window login and upload-grant rate limits with deterministic
  tests;
- security headers and rejection of non-loopback listening unless the operator
  asserts a secure deployment.

The rate limiters are process-local and reset on restart. Actual TLS
termination is not implemented: non-loopback service requires a trusted HTTPS
reverse proxy, and `DUMP_LEDGER_HTTPS=true` only selects secure-cookie/HSTS
behavior. Proxy configuration, end-to-end TLS validation, request-duration
timeouts, storage-exhaustion drills, and resumable multi-gigabyte uploads remain
release work.

## M4 — Retention, purge, and operations: partially implemented

Implemented and tested:

- explicit future `purge_at` assignment for available/rejected dumps;
- due-item selection, completion of interrupted deletion, two-phase purge, and
  tombstone retention;
- metadata-only backup inventory and SQLite integrity status;
- a bounded production periodic job for explicitly assigned `purge_at` values,
  with interval, batch size, run count, and failure status exposed at runtime;
- operations output for integrity errors, upload admission, post-processing,
  and runtime jobs.

Deferred:

- automatic coverage-specific retention defaults;
- direct purge-confirmation UX and a finalized concurrent download/purge rule;
- acceptance testing of the implemented SQLite online-backup operation;
- intake pause, immutable-vault copy/snapshot, signed inventory, restore hash
  validation, backup expiry, and tombstone replay;
- disk-space and backup-state health, deployment incident procedures, and grant
  key rotation.

## M5 — Product completion and packaging: deferred

Remaining product/release work includes selecting an open-source license,
local import, notes, external issue links, separate analyst/operator
authorization if required, systemd packaging, Windows service/installer and ACL
validation, reproducible release bundles, upgrade/restore drills, and
dependency/license inventory.

## Current commands

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run check:model-interface
pnpm run build
pnpm run test:unit
pnpm run test:integration
pnpm run test:mbt
```

`pnpm test` runs the typecheck, model-interface check, build, unit tests,
integration tests, and MBT tests. During the specification-only case-workflow
revision, the model-interface and MBT portions are expected to fail freshness
until implementation and regeneration occur. TLC and Apalache remain separate
explicit formal gates:

```sh
tlc -config specs/DumpLedger.cfg specs/DumpLedger.tla
apalache-mc check \
  --no-deadlock \
  --init=Init \
  --next=Next \
  --inv=SafetyInvariant \
  --length=8 \
  specs/DumpLedger.tla
```

Trace regeneration is explicit and review-gated; see
[`../specs/mbt/README.md`](../specs/mbt/README.md). It never repairs the lock or
generated tree automatically.
