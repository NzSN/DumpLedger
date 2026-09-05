# DumpLedger

DumpLedger is a lightweight, self-hosted intake ledger for Windows minidumps.
It keeps the association between a customer, a support case, and one or more
dump files without requiring an operator to administer a database directly.

The repository now contains a working TypeScript 7 implementation for one
active Node.js 24 process on one host. It includes the SQLite lifecycle ledger,
filesystem vault, bounded minidump inspection, server-rendered operator and
uploader pages, startup reconciliation, and generated-port MirrorECMA
model-based tests. It is an implementation baseline, not yet a production
release.

## Design index

- [`docs/product-design.md`](docs/product-design.md) defines the product scope,
  domain language, user flows, and minimum interface.
- [`docs/architecture.md`](docs/architecture.md) defines the module seams,
  persistence model, deployment shape, and crash-recovery protocol.
- [`docs/security-model.md`](docs/security-model.md) defines the threat model
  and controls required for untrusted, sensitive memory dumps.
- [`docs/formal-model.md`](docs/formal-model.md) maps the implementation design
  to the TLA+ state machine and its safety properties.
- [`docs/implementation-plan.md`](docs/implementation-plan.md) breaks delivery
  into independently verifiable milestones.
- [`specs/DumpLedger.tla`](specs/DumpLedger.tla) is the executable TLA+ model.
- [`specs/DumpLedger.svg`](specs/DumpLedger.svg) visualizes its case workflow,
  association, grant, intake, validation, and deletion state machines.

## Deployment shape

```text
HTTPS reverse proxy (required for non-loopback deployment)
  `-- one Node.js 24 DumpLedger process
        |-- Fastify + server-rendered HTML
        |-- managed SQLite ledger
        `-- filesystem vault on an encrypted local volume
```

The dump bytes are never stored in SQLite. SQLite contains metadata and
associations; the vault contains immutable dump objects addressed by opaque
dump identifiers.

DumpLedger does not currently terminate TLS itself. `DUMP_LEDGER_HTTPS=true`
enables secure-cookie/HSTS behavior and asserts that a trusted HTTPS endpoint
is in front of the process; it is not a TLS implementation.

## Implementation status

Implemented and exercised by automated tests:

- branded identifiers, SQLite migrations, immutable dump/case association,
  one-time case-bound grants, lifecycle auditing, and explicit retention dates;
- streaming upload with SHA-256, configured byte/concurrency limits,
  process-local login and upload-grant rate limits, immutable promotion, and
  post-processing retry bounds;
- startup reconciliation, two-phase purge, SQLite integrity checks, and a
  metadata-only backup inventory;
- bounded periodic scheduling of explicitly assigned `purge_at` values;
- bounded random-access minidump inspection and
  `partial`/`full-memory-declared`/`unknown` classification;
- authenticated operator pages, case manifests, controlled downloads, and
  basic operations health;
- generated MirrorECMA bindings and six checked-in MBT traces that drive the
  real synchronous lifecycle engine.

The TLA+ model now also specifies an operator-controlled case workflow and
closure-time grant revocation. That revision is specification-only: runtime
case transitions and the corresponding generated interface/MBT artifacts have
not been implemented yet, so model-interface freshness is intentionally red
until that work is performed as one reviewed change.

Deferred before a production release:

- selection of the repository's open-source license;
- in-process TLS termination or a packaged, verified reverse-proxy setup;
- automatic coverage-specific retention defaults;
- coordinated vault copy, restore verification, and tombstone replay;
- grant-key rotation, local operator import, Windows service/installer
  packaging, and release bundles;
- validation against a retained corpus of real crash dumps and fuzz-generated
  parser regressions.

An SQLite online-backup API is implemented, but coordinated vault backup and a
restore exercise are not; the database copy alone is not a DumpLedger backup.
The current fixed-window rate limits are bounded and tested but process-local;
they reset on restart and are not a substitute for an outer network/DoS limit.

## Build and test

The local sibling `../MirrorECMA` dependency and a built Mirrors checkout are
required for the complete MBT gate.

```sh
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run check:model-interface
pnpm run build
pnpm run test:unit
pnpm run test:integration
pnpm run test:mbt
```

`pnpm test` runs the typecheck, model-interface check, build, and all three test
tiers in that order. Model-trace regeneration is an explicit maintainer action,
not part of the test repair path; see
[`specs/mbt/README.md`](specs/mbt/README.md).

## Run locally

Generate a stable grant-HMAC key and an scrypt operator-password hash before
starting the process. The password prompt hides input and asks for confirmation:

```sh
npm run --silent generate:grant-key
npm run --silent generate:operator-password-hash
```

Assign the two printed values to the corresponding environment variables:

```sh
export DUMP_LEDGER_GRANT_KEY='<unpadded-base64url, at least 32 decoded bytes>'
export DUMP_LEDGER_OPERATOR_PASSWORD_HASH='<generated scrypt value>'
npm start
```

In PowerShell, the output can be assigned directly while the password prompt
remains interactive:

```powershell
$env:DUMP_LEDGER_GRANT_KEY = npm run --silent generate:grant-key
$env:DUMP_LEDGER_OPERATOR_PASSWORD_HASH = npm run --silent generate:operator-password-hash
npm start
```

The default listener is `127.0.0.1:4080` and the default data directory is
`./data`. The grant key must remain stable across restarts and must be backed up
separately from the SQLite file. Do not place either secret in version control.
See `src/main.ts` for validated optional environment settings controlling the
listen address, upload concurrency, retry queue, and retention scheduler.

## Formal checks

With the TLA+ tools installed:

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

The 2026-09-05 case-workflow revision produced 515,075 TLC-generated states,
99,143 distinct states, depth 23, with no invariant violation; Apalache found no
counterexample through length 8. The six checked-in generated traces and their
13-action semantic digest predate this revision and remain intentionally stale
until implementation begins.

These are bounded model and finite conformance results. They do not establish
that the whole application is formally verified; see
[`docs/formal-model.md`](docs/formal-model.md) for the evidence boundary.
