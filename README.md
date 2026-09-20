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
- [`docs/import-export-design.md`](docs/import-export-design.md) proposes the
  export bundle format, verified import pipeline, and delivery milestones.
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

The operator API requires an external TLS endpoint. `DUMP_LEDGER_HTTPS=true`
enables secure-cookie/HSTS behavior and asserts that a trusted HTTPS endpoint
is in front of that API; it does not enable TLS on the API socket. The optional
dedicated symbol listener supports its own TLS certificates (below).

In HTTPS mode, forwarded headers are trusted only from `127.0.0.1` and `::1`
by default. Set `DUMP_LEDGER_TRUSTED_PROXIES` to a comma-separated list of
proxy IP addresses or narrow CIDRs for a different topology; an empty value
trusts none. The proxy must overwrite `X-Forwarded-Proto` and
`X-Forwarded-Host`, and overwrite `X-Forwarded-For` with the client address or
append the actual peer address. Never forward an unchecked client-supplied
chain unchanged. Keep the API socket inaccessible except through the proxy.

Dump and symbol uploads default to a 60-second idle deadline and a one-hour
total deadline. Configure `DUMP_LEDGER_UPLOAD_IDLE_TIMEOUT_MS` and
`DUMP_LEDGER_UPLOAD_TOTAL_TIMEOUT_MS` in milliseconds for large/slow transfers
(positive integers through 2147483647; zero cannot disable them). A trickle
does not reset the total deadline. Expiry closes the connection, removes
staging bytes, and releases upload admission; a consumed grant slot stays
consumed. These values also bound HTTP socket idle time and request reception;
headers have a maximum 60-second deadline, shortened by a smaller total limit.

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
- operator-API TLS termination or a packaged, verified reverse-proxy setup;
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

A release pipeline can ingest symbols with a bearer token instead of an
operator session (it cannot list or purge; see
[`docs/security-model.md`](docs/security-model.md)). Generate the token once,
put it in the CI secret store, and export only the printed sha256 — leaving
the variable unset keeps token auth disabled:

```sh
npm run --silent generate:ingest-token
export DUMP_LEDGER_INGEST_TOKEN_HASH='<64 lowercase hex characters>'
```

Debuggers can fetch symbols without touching the operator surface: set
`DUMP_LEDGER_SYMBOLS_PORT` to start a dedicated, unauthenticated, read-only
symsrv listener. Its default bind is **127.0.0.1**, for local debugger access
over HTTP. Remote access requires trusted HTTPS or an authenticated tunnel.
To bind on a network interface, set `DUMP_LEDGER_SYMBOLS_HOST` and both
`DUMP_LEDGER_SYMBOLS_TLS_CERT` (PEM certificate chain file) and
`DUMP_LEDGER_SYMBOLS_TLS_KEY` (PEM private key file). The listener then uses
TLS 1.2 or newer. Install the issuing CA on analyst machines so certificate
validation succeeds. A non-loopback bind without both files fails startup;
`DUMP_LEDGER_HTTPS=true` cannot override that check.

Alternatively, keep the symbol socket on loopback behind a local TLS proxy
or an authenticated tunnel. Symbol GUID/age and image timestamp/size are
lookup metadata, not cryptographic authentication of the downloaded bytes.

The remote symbol path is the single-store form
`.sympath SRV*C:\symcache*https://<host>:<port>/symbols`: `symsrv.dll`
accepts at most one HTTP store, and it must be the last store in the path —
a second HTTP store (for example Microsoft's public server) makes it reject
the whole path with "Any HTTP store must be the last store in the list".
Local directory stores may precede the single HTTP store, but Microsoft OS
symbols and DumpLedger artifacts cannot chain in one path: use DumpLedger
alone for application symbols, pre-populate a local directory store of OS
PDBs ahead of it, or swap `.sympath` when OS frames matter. Leaving the
variable unset keeps the listener disabled; see
[`docs/security-model.md`](docs/security-model.md) for the threat model.

For local CDB, set `DUMP_LEDGER_SYMBOLS_PORT='4082'`, leave the host unset,
and use `.sympath SRV*C:\symcache*http://127.0.0.1:4082/symbols`.
**Upgrade note:** deployments previously using `DUMP_LEDGER_SYMBOLS_HOST=0.0.0.0`
must configure the TLS files or change to loopback and a protected transport
before restarting. These settings require no ledger migration or vault rewrite.

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

The companion transfer model of export/import is checked separately (it
extends the base spec and is not part of the model interface or MBT corpus);
see `specs/README.md` for its TLC and Apalache commands.
```

The 2026-09-05 case-workflow revision produced 515,075 TLC-generated states,
99,143 distinct states, depth 23, with no invariant violation; Apalache found no
counterexample through length 8. The six checked-in generated traces and their
13-action semantic digest predate this revision and remain intentionally stale
until implementation begins.

These are bounded model and finite conformance results. They do not establish
that the whole application is formally verified; see
[`docs/formal-model.md`](docs/formal-model.md) for the evidence boundary.
