# TypeScript 7 implementation plan

## 1. Outcome

Deliver a lightweight, self-hosted DumpLedger process that:

- records customer, case, grant, dump, and audit associations in SQLite;
- streams dump bytes to an encrypted local filesystem without buffering the
  complete upload;
- classifies structurally valid partial/full-memory-declared minidumps;
- recovers safely from interruption between ledger and filesystem changes;
- presents server-rendered operator and upload pages;
- is exercised as a real SUT through the compiler-generated MirrorECMA port;
- requires no database administration, Java runtime, frontend process, or
  container runtime.

The first release is one active Node.js process on one host. Multi-writer and
network-filesystem operation remain unsupported.

## 2. Toolchain

Use:

- TypeScript 7.x, installed exactly and locked by `pnpm-lock.yaml`;
- Node.js 24 LTS as the production runtime;
- ESM with `module` and `moduleResolution` set to `NodeNext`;
- pnpm, matching the MirrorECMA development ecosystem;
- `better-sqlite3` for synchronous short transactions;
- Fastify for the HTTP shell;
- server-rendered templates and small embedded static assets;
- Node's test runner for module and integration tests.

Do not depend on TypeScript's programmatic compiler interface. TypeScript 7.0
does not provide the old interface, and DumpLedger does not need it: Mirrors'
Lean executable performs model-interface compilation.

Production runs emitted JavaScript. Do not use Node's type-stripping mode as a
replacement for `tsc`, and do not make Node single-executable packaging a
release requirement while that mechanism remains under active development.

Minimum compiler settings:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "rootDir": ".",
    "outDir": "dist",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "useUnknownInCatchVariables": true,
    "noEmitOnError": true,
    "skipLibCheck": false
  }
}
```

## 3. Repository layout

```text
dump-ledger/
  package.json
  pnpm-lock.yaml
  tsconfig.json
  src/
    main.ts
    domain/
      ids.ts
      lifecycle.ts
      errors.ts
    engine/
      dump-ledger-engine.ts
      commands.ts
      projection.ts
    ledger/
      sqlite-ledger.ts
      migrations.ts
      statements.ts
    vault/
      vault.ts
      filesystem-vault.ts
      memory-vault.ts
    inspection/
      minidump-inspector.ts
      scripted-inspector.ts
    intake/
      upload-session.ts
      intake-facade.ts
    recovery/
      reconcile.ts
    auth/
      grants.ts
      sessions.ts
    http/
      server.ts
      routes/
      views/
    generated/dump-ledger/
      DumpLedgerMirror.generated.ts
      .model-interface-generated.json
    mbt/
      dump-ledger-mbt-port.ts
      dump-ledger-selection.ts
      mbt-harness.ts
  model-interface/
    DumpLedger.mirror-interface.json
    DumpLedger.mirror-interface.lock.json
    DumpLedger.mirror-interface.coverage.json
  specs/
    DumpLedger.tla
    DumpLedger.cfg
    mbt/
  test/
    fixtures/minidump/
    fixtures/mbt/traces/
    fixtures/mbt/negative/
    unit/
    integration/
    mbt/
  tools/
    generate-mbt-traces.ts
    check-model-interface.sh
```

The compiler-generated directory is owned only by its generated manifest.
Nothing else is placed there.

## 4. Module shape

```text
HTTP shell
    |
    v
intake facade -------- streams bytes --------> vault seam
    |                                           /       \
    v                                  filesystem     memory
lifecycle engine                                  test adapter
    |          \
    v           v
SQLite ledger   inspection seam
                    /        \
             minidump       scripted
```

### 4.1 Lifecycle engine

The lifecycle engine is the deep module shared by production orchestration and
MBT. Its interface is synchronous and small:

```ts
export interface DumpLedgerEngine {
  execute(command: LifecycleCommand): TransitionReceipt;
  snapshot(): DumpLedgerProjection;
}
```

`LifecycleCommand` is a closed discriminated union for the durable actions
represented in TLA+: grant issue/revoke/expiry, upload begin/seal/failure,
object promotion, quarantine, inspection outcome, and two-phase purge.

The engine owns:

- phase preconditions and terminal-state rules;
- immutable case association;
- token consumption;
- short SQLite transactions and audit rows;
- calls to vault/inspection adapters at the appropriate checkpoint;
- stable classified errors;
- projection of observable state.

It does not own HTTP request parsing or asynchronous byte transfer.

### 4.2 Synchronous engine versus asynchronous upload

MirrorECMA's generated port is synchronous. Preserve that constraint instead
of returning an unobserved promise from a `void` method.

Production upload flow is split deliberately:

1. the HTTP shell obtains an asynchronous request stream;
2. the intake facade calls synchronous `BeginUpload`;
3. Node `stream.pipeline` writes the staging file and updates SHA-256 with
   backpressure;
4. on success the facade calls synchronous `SealUpload` with final byte count
   and digest; on failure it calls synchronous `FailUpload`;
5. a local worker calls the later engine commands synchronously.

No SQLite transaction remains open across an `await`, network read, hashing
loop, filesystem stream, or minidump scan.

The MBT adapter drives the same lifecycle engine with deterministic staging
fixtures. It does not drive Fastify or fake the state transition logic.

### 4.3 Ledger module

The ledger module owns `better-sqlite3` directly. Do not add a generic database
interface: there is one production implementation, while tests use the same
implementation with a temporary or in-memory database.

Required rules:

- enable foreign keys and WAL for file-backed databases;
- apply numbered migrations transactionally;
- prepare and reuse statements;
- use `WHERE phase = :expectedPhase` on state transitions and require exactly
  one changed row;
- write the lifecycle update and corresponding audit event in one transaction;
- prohibit updates to `dumps.case_id` after insertion;
- store grant-secret digests, never grant secrets;
- store no dump bytes or derived large blobs in SQLite;
- expose backup and integrity-check operations through the program.

Use explicit SQL in this module rather than an ORM. The schema is part of the
durability interface and should remain reviewable.

### 4.4 Vault seam

The seam is real because it has two adapters:

- `FilesystemVault` for production and filesystem acceptance tests;
- `MemoryVault` for deterministic MBT and failure scheduling.

Both must pass one shared contract suite. The interface includes exclusive
staging creation, append/sync/close, atomic promotion, immutable open, removal,
and presence inspection. Only server-generated identifiers reach path
construction.

The production adapter requires staging and vault roots on the same local
filesystem. Promotion uses rename followed by directory synchronization where
the platform provides it.

### 4.5 Inspection seam

The production adapter performs bounded random-access minidump inspection. The
scripted adapter supplies deterministic `valid(kind)` or `invalid(reason)`
outcomes to MBT while exercising the real engine branch.

The production inspector:

- verifies `MDMP` and required header/directory ranges;
- uses checked `bigint` arithmetic before converting positions to numbers;
- caps every untrusted count and string length;
- records raw flags and observed stream facts;
- reports `partial`, `full-memory-declared`, or `unknown` without claiming
  complete process memory;
- never executes a debugger, extension, module, or uploaded code.

Both adapters satisfy the same result interface. Parser-specific fixtures and
fuzzing remain separate from lifecycle MBT evidence.

### 4.6 Internal deterministic seams

Clock, entropy, and identifier sources have production and deterministic test
adapters, but remain internal to the engine/intake implementation. They are not
exposed through HTTP or generated model types.

## 5. Runtime validation and identifiers

TypeScript types do not validate external input. Parse every route parameter,
form field, environment value, JSON value, database row, and generated-port
input before domain use.

Use branded identifiers after validation:

```ts
declare const DumpIdBrand: unique symbol;
export type DumpId = string & { readonly [DumpIdBrand]: true };
```

Do not cast arbitrary strings to branded IDs. Each brand has one constructor
that validates canonical syntax.

The MBT model uses small integer slots. The handwritten adapter alone maps
those slots to real branded IDs returned by the engine; production IDs never
enter TLA+ traces.

## 6. Delivery milestones

### M0 — Baseline and toolchain

Deliver:

- select and commit the open-source license;
- revise `docs/architecture.md` and `docs/implementation-plan.md` from Go to
  TypeScript 7/Node.js 24;
- add exact tool versions, package scripts, lockfile, and empty module layout;
- pin the MirrorECMA dependency and record the compatible Mirrors compiler
  revision;
- complete the compiler-compatible TLA+ migration in the MBT plan.

Gate:

```text
pnpm install --frozen-lockfile
pnpm run typecheck
TLC complete exploration
Apalache bounded check
model_interface_gen resolve
```

### M1 — Domain and lifecycle engine

Deliver:

- branded IDs and closed lifecycle types;
- SQLite schema/migrations;
- synchronous lifecycle engine with compare-and-transition transactions;
- deterministic clock/entropy/ID adapters;
- read-only projection used by the generated port.

Gate:

- every legal TLA+ transition succeeds through `execute`;
- every illegal transition returns a stable error without partial mutation;
- case association cannot change after `BeginUpload`;
- token terminal states cannot return to `issued`;
- first generated-port MBT replay passes with memory vault/scripted inspector.

### M2 — Vault and crash recovery

Deliver:

- production filesystem vault;
- staging, sealing, promotion, quarantine, and two-phase deletion;
- startup reconciler for every documented ledger/blob combination;
- deterministic crash failpoints at durable checkpoints.

Gate:

- shared vault contract suite passes for memory and filesystem adapters;
- kill/restart tests at every failpoint preserve the TLA+ safety invariants;
- available never appears without vault bytes, digest, and valid inspection;
- deleting never regains download capability;
- MBT passes against the engine with the filesystem adapter for selected
  acceptance traces.

### M3 — Minidump inspection

Deliver:

- bounded parser and coverage classifier;
- partial, full-memory-declared, unknown, truncated, and malformed fixtures;
- structured dump facts suitable for the detail page.

Gate:

- parser contract tests and fuzz corpus pass;
- no file-sized allocation occurs;
- `MiniDumpWithFullMemoryInfo` alone never yields full-memory-declared;
- real-parser integration traces agree with scripted MBT outcomes for their
  fixed fixtures.

### M4 — Intake and local operator interface

Deliver:

- streaming import and upload sessions;
- customer/case/grant/dump pages;
- local operator authentication and one-time grants;
- download authorization and audit events;
- case manifest export.

Gate:

- upload larger than the configured process-memory budget remains bounded;
- disconnect/oversize/storage-full paths end in non-downloadable states;
- grant expiry, revocation, and replay fail closed;
- filenames cannot affect vault paths or response headers unsafely;
- HTTP integration tests prove that calls reach the same lifecycle engine used
  by MBT.

### M5 — Retention, purge, backup, and restore

Deliver:

- retention scheduler and full-memory-specific defaults;
- begin/finish purge worker;
- coordinated SQLite/vault backup inventory;
- restore verification and tombstone replay;
- health/operations page.

Gate:

- restored available objects match recorded hashes;
- old backups cannot silently resurrect purged dumps;
- concurrent download/purge follows the documented rule;
- MBT deletion traces and kill/restart tests remain green.

### M6 — Release acceptance

Deliver:

- reproducible release bundle containing Node, emitted JavaScript, static
  assets, migrations, and runtime dependencies;
- installation instructions for a dedicated operating-system identity;
- systemd definition first; Windows background-process installation may follow;
- upgrade, backup, key-rotation, and incident instructions.

Gate:

- clean-host installation and upgrade from the previous schema;
- all commands in the MBT plan;
- allowlisted mTLS MirrorECMA acceptance;
- dependency and license inventory;
- no secret, dump bytes, customer filename, or recovered memory in logs.

## 7. Required package scripts

The final names may vary, but these capabilities are mandatory:

```json
{
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test:unit": "node --test dist/test/unit/**/*.test.js",
    "test:integration": "node --test dist/test/integration/**/*.test.js",
    "test:mbt": "node --test dist/test/mbt/**/*.test.js",
    "check:model-interface": "bash tools/check-model-interface.sh",
    "test": "pnpm run typecheck && pnpm run check:model-interface && pnpm run test:unit && pnpm run test:integration && pnpm run test:mbt"
  }
}
```

The shell script contains read-only compiler checks only. Regeneration is an
explicit maintainer action, never part of CI repair.

## 8. Evidence limits

- TLC/Apalache validate the abstract finite transition model.
- Compiler preflight validates trace schema, types, action coverage, and exact
  observation coverage.
- Generated binding tests validate projection, conversion, lifecycle
  poisoning, and action dispatch.
- MirrorECMA replay validates the real lifecycle engine against model traces.
- Filesystem, SQLite, parser, HTTP, and kill/restart tests validate adapters and
  effects not represented as literal bytes/syscalls in TLA+.
- A green MBT trace corpus is finite coverage evidence, not proof over every
  production UUID, dump byte sequence, filesystem, or crash schedule.

No result should collapse these layers into a generic “formally verified”
claim.

## 9. Open release choices

These choices do not block M1 but must close before M6:

1. AGPL-3.0 versus a permissive license for DumpLedger.
2. Versioned publication of MirrorECMA versus a pinned sibling/git dependency.
3. Linux-only first release versus simultaneous Windows packaging.
4. TLS termination in-process versus a locally managed reverse proxy.
5. Exact default retention periods for partial and full-memory-declared dumps.
