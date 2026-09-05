# Architecture

## One-sentence architecture

A single Node.js 24 process, built from strict TypeScript 7, presents a small
intake interface over a deep synchronous ledger module: uploads are streamed
through a crash-recoverable staging protocol, inspected without execution, and
made downloadable only after the SQLite record and immutable filesystem object
agree.

## Deployment shape

```text
browser
   |
   | HTTPS (external termination)
   v
trusted reverse proxy
   |
   | loopback HTTP
   v
+----------------------- dump-ledger process -----------------------+
| Fastify shell -> intake module -> inspection module               |
|                    |              |                               |
|                    v              v                               |
|                 ledger         minidump facts                     |
|                    |                                              |
|             SQLite implementation                                 |
|                    |                                              |
|                vault seam                                         |
|              /            \                                       |
| filesystem adapter      in-memory adapter (tests)                 |
+-------------------------------------------------------------------+
                         |
                  encrypted volume
```

The TypeScript build emits JavaScript run by Node.js. HTML, CSS, and the small
upload script are served by the same Fastify process, so there is no separate
frontend process or database daemon. TLS termination is not implemented in
DumpLedger: a non-loopback deployment requires a trusted HTTPS endpoint in
front of it. `DUMP_LEDGER_HTTPS=true` selects secure-cookie/HSTS behavior and
is an operator assertion about that endpoint, not proof that TLS exists.

## Module design

### HTTP shell

The shell handles routing, authentication, request limits, CSRF protection,
and rendering. It translates HTTP input into typed commands and renders typed
results. It contains no lifecycle or storage decisions.

### Intake module

The intake facade splits asynchronous byte transfer from the synchronous
lifecycle engine. The implemented remote upload path uses these conceptual
operations:

```text
beginUpload(grantSecret, presentedMetadata) -> dumpID
appendBytes(dumpID, bytes) -> progress
sealUpload(dumpID, byteCount, sha256)
postProcess(dumpID) -> available | rejected
```

The HTTP shell awaits Node's streaming pipeline, while every engine command,
SQLite transaction, vault transition, inspection call, generated-port action,
and observation is synchronous. No SQLite transaction remains open across an
`await`. A bounded retry queue handles post-transfer processing failures; a
startup reconciler handles durable interruption. Local operator import has not
yet been implemented.

The interface includes these ordering constraints:

- `appendBytes` is valid only for the currently open receiving session.
- `sealUpload` is valid once after the byte stream has ended; recovery resumes
  later durable phases rather than resealing through the command interface.
- a grant secret is accepted by at most one successful `beginUpload`.
- `BeginPurge` disables new downloads before `FinishPurge` removes bytes.

### Ledger module

The ledger module owns SQLite directly. There is no generic database port in
the first release: only one production implementation is justified, and
SQLite's in-memory mode exercises the same implementation in tests.

The module owns schema migration, transactions, queries, SQLite integrity
checking, and SQLite backup.
No caller constructs SQL. Its external interface expresses domain operations
such as creating a case, recording an intake transition, authorizing a
download, and returning a case manifest.

### Vault module

The vault seam exists because two adapters are required:

- the filesystem adapter is used in production;
- the in-memory adapter is used for deterministic failure and property tests.

Its interface is intentionally small:

```text
createStaging(dumpID)
append(stagingHandle, bytes)
syncAndClose(stagingHandle)
promote(dumpID)
openImmutable(dumpID)
remove(dumpID)
inspectPresence(dumpID)
```

The filesystem adapter guarantees that staging and vault directories reside on
the same filesystem, so promotion can use an atomic rename. It refuses symlink
targets and never derives a path from a customer-controlled filename.

### Inspection module

Inspection is pure over a random-access reader and file length. It parses only
the minidump header, stream directory, and bounded metadata needed for:

- signature and version checks;
- stream range bounds and integer-overflow checks;
- header flags;
- `MemoryListStream` and `Memory64ListStream` facts;
- captured-memory byte count;
- system architecture, exception code, and module identifiers when present;
- coverage classification.

It never loads a complete dump into memory and never invokes a debugger,
symbol handler, executable loader, or customer-supplied code.

### Authentication module

The first release supports a local administrator account and one-time upload
grants. Password hashes, grant-token hashes, sessions, and authorization checks
are owned here. An external identity-provider seam is deferred until a second
production adapter is required.

### Generated MirrorECMA MBT seam

The lifecycle acceptance path is:

```text
checked-in ITF traces
  -> Mirrors-verified model interface
  -> MirrorECMA negotiated runner
  -> generated DumpLedger binding and StateComputer
  -> handwritten DumpLedgerPort adapter
  -> real lifecycle engine, SQLite ledger, and selected vault/inspector
```

`src/generated/dump-ledger/` is owned by Mirrors `model_interface_gen`; only
the generator may change that tree. The handwritten adapter in `src/mbt/`
maps finite model slots to real branded IDs and invokes the production engine.
It does not receive expected trace state and does not read
`StateComputer.prevState`.

The generated `StateComputer` contract is synchronous. Consequently the
generated methods, handwritten adapter, engine transitions, and observations
must complete synchronously and must not return unobserved promises. Network
upload streaming remains in the asynchronous HTTP/intake shell and is sealed
before later synchronous lifecycle commands run.

## Persistence model

### SQLite ledger

The minimum logical schema is:

```text
customers
  customer_id, display_name, created_at

cases
  case_id, customer_id, title, status, created_at

upload_grants
  grant_id, case_id, secret_digest, state, expires_at, max_bytes,
  consumed_by_dump_id, created_at

dumps
  dump_id, case_id, phase, blob_state, original_name, byte_size, sha256,
  validation, coverage, downloadable, inspection_error,
  inspection_facts_json, received_at, available_at, purge_at, purged_at

audit_events
  event_id, occurred_at, action, customer_id, case_id, dump_id, detail_json
```

Foreign keys are enabled. IDs are immutable. `dumps.case_id` has no update path
in the domain interface. Secret tokens are never stored verbatim.

SQLite runs in WAL mode for short metadata transactions. The application is a
single active writer; analysis downloads and UI searches may read
concurrently. Long filesystem operations occur outside write transactions.

### Filesystem vault

```text
data/
  ledger.sqlite
  staging/
    <dump-id>.part
  vault/
    <dump-id>/original.dmp
```

Only opaque, server-generated values appear below `staging/` and `vault/`.
The original customer filename is metadata. Case manifests are generated from
the ledger on request; there is no authoritative manifest file in the vault.

## Crash-consistent intake protocol

SQLite and the filesystem do not share a transaction. DumpLedger therefore
uses explicit recoverable phases rather than pretending the two writes are
atomic.

1. **Prepare:** allocate a dump ID and exclusively create an empty staging file.
   No customer bytes are accepted yet; an unreferenced empty file is safe to
   remove during reconciliation.
2. **Begin:** consume the grant and insert the case-bound `receiving` dump
   record in one SQLite transaction.
3. **Receive:** stream bytes to staging while calculating SHA-256 and enforcing
   the grant limit.
4. **Seal:** flush and `fsync` the staging file, close it, then record `sealed`,
   final byte count, and digest.
5. **Promote:** atomically rename the staging file to its immutable vault path
   and `fsync` the containing directory.
6. **Quarantine:** record `quarantined` only after the vault object is observed
   at the expected path.
7. **Inspect:** parse bounded metadata. A valid result records facts and moves
   to `available`; a failure moves to `rejected`. Only `available` is
   downloadable.

Startup reconciliation handles each durable state:

| Ledger phase | Observed bytes | Recovery |
| --- | --- | --- |
| no ledger record | unreferenced staging file | remove after a conservative age threshold |
| `receiving` | no staging file | mark `transfer-failed` |
| `receiving` | stale staging file | remove staging; mark `transfer-failed` |
| `sealed` | staging only | resume promotion |
| `sealed` | vault object | record `quarantined`; inspect |
| `quarantined` | vault object | repeat idempotent inspection |
| `available` | missing vault object | remove download capability; raise integrity alarm |
| `rejected` | staging residue | remove staging |
| `deleting` | any remaining bytes | remove bytes; commit `deleted` |
| `deleted` | any dump bytes | remove residue and raise audit warning |

No recovery transition changes `case_id`, reactivates a consumed grant, or
publishes a dump without a vault object and validation evidence.

## Concurrency and resource limits

- Each active dump ID has exactly one receiving session.
- A configurable in-process admission counter bounds concurrent uploads.
- Login and upload-grant verification use bounded, process-local fixed-window
  rate limiters; their state resets on restart, so an outer network limit is
  still required for internet-facing service.
- Request bodies use Node stream backpressure and are never collected into one
  file-sized application buffer.
- Upload byte limits are checked before and during receipt.
- A bounded periodic job processes explicitly assigned `purge_at` values;
  policy does not yet assign coverage-specific defaults automatically.
- SQLite write transactions contain metadata only and never wait on network or
  filesystem streaming.
- Download readers hold an immutable file descriptor. Purge first commits
  `deleting` to disable new downloads, then removes bytes and commits
  `deleted`. A cross-platform policy for already-open downloads is not yet
  complete and must be validated before Windows packaging.

The first release is one active process on one host. Network filesystems and
multiple writers would invalidate assumptions about rename, locking, and
durability and are therefore unsupported.

## Error interface

External errors use stable categories without leaking paths or secrets:

```text
invalid_input
not_found
invalid_transition
grant_invalid
grant_expired
grant_consumed
storage_unavailable
integrity_failure
inspection_outcome_mismatch

# HTTP intake mappings
upload_too_large
upload_incomplete
upload_busy
rate_limited
```

Internal logs include a correlation ID, dump ID when allocated, and structured
cause. They must not include grant secrets or recovered process-memory data.

## Backup and restore status

The engine currently exposes SQLite's online backup operation, SQLite
integrity checking, and a metadata inventory that explicitly states
`includesVaultBytes: false`. It does not yet pause intake, copy the immutable
vault, sign the inventory, restore vault bytes, verify restored hashes, or
replay tombstones against an older backup. Those operations remain required
before backup/restore can be described as coordinated or production-ready.
