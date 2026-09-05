# MirrorECMA MBT and generated-port plan

## 1. Normative requirement

DumpLedger lifecycle MBT must execute through this path:

```text
checked-in ITF traces
        |
        v
Mirrors register_traces + compiled model-interface verification
        |
        v
MirrorECMA runClientWithTracesNegotiated
        |
        v
compiler-generated DumpLedgerBinding / StateComputer
        |
        v
handwritten DumpLedgerPort adapter
        |
        v
real DumpLedger lifecycle engine
```

A test that calls TLA+ actions and a second handwritten state machine side by
side does not satisfy this requirement. The generated binding must own action
dispatch, input projection, ITF/native conversion, observation validation,
coverage, poisoning, and the `StateComputer` seam.

The handwritten adapter owns only the mapping from generated model slots to the
real DumpLedger engine and its session-local resources. It must never receive
expected trace state or use `StateComputer.prevState`.

## 2. Existing interfaces that remain unchanged

Use the current implemented target and runner:

- target profile: `mirrorecma-v1`;
- state-computer contract: `mirrors.state-computer/v1`;
- MirrorECMA runner: `runClientWithTracesNegotiated`;
- exact adapter registry: `CompiledAdapterRegistry`;
- generated factory: `bindDumpLedger`;
- negotiation request: compiled `verify` with policy `require`.

Do not create a `typescript7-v1` target. `mirrorecma-v1` names the generated
client representation and runtime contract, not the compiler version used by
the consuming application.

Do not use MirrorECMA dynamic descriptor mode for the production acceptance
path. The generated TypeScript source and application adapter are reviewed and
committed locally.

## 3. Phase A — make the TLA+ model compiler-compatible

### 3.1 Rename the action variable

Rename `actionTaken` to `action_taken` everywhere. Version 1 of the resolver
requires that exact spelling, and strict preflight also reads that field
directly.

Keep the wire values unchanged and case-sensitive:

```text
Init
IssueToken
RevokeToken
ExpireToken
BeginUpload
SealUpload
FailUpload
PromoteObject
MarkQuarantined
AcceptDump
RejectDump
BeginPurge
FinishPurge
```

### 3.2 Add the parameter variable

Add one variable with compiler-supported closed-record type:

```tla
\* @type: { token: Int, dump: Int, kind: Str };
parameters
```

Use `0` as the absent token/dump slot and `"unclassified"` as the absent kind.
Every initializer/transition sets all three fields so stale parameters cannot
leak from the preceding state.

Examples:

```tla
IssueToken(t) ==
  /\ ...
  /\ parameters' = [token |-> t, dump |-> 0, kind |-> NoCoverage]

BeginUpload(t, d) ==
  /\ ...
  /\ parameters' = [token |-> t, dump |-> d, kind |-> NoCoverage]

AcceptDump(d, kind) ==
  /\ ...
  /\ parameters' = [token |-> 0, dump |-> d, kind |-> kind]
```

Add `parameters` to `vars`, initialize it, type-check it in `TypeOK`, and set it
in every action rather than placing it in `UNCHANGED`.

### 3.3 Replace unsupported state-function evidence

The current ITF annotations such as `Str -> Str` are not accepted by the
version-1 evidence parser. Preserve the finite semantics while representing
model slots with sequences:

```text
Customers = 1..2
Cases     = 1..2
Tokens    = 1..2
Dumps     = 1..2

tokenState : Seq(Str)
tokenDump  : Seq(Int)   -- 0 means no dump
dumpPhase  : Seq(Str)
dumpCase   : Seq(Int)   -- 0 means no case
blobState  : Seq(Str)
validation : Seq(Str)
coverage   : Seq(Str)

digestRecorded : Set(Int)
downloadable   : Set(Int)
```

Production identifiers remain opaque strings. Integers are finite model slots
only; the client-local adapter maps them to real branded IDs created by the
SUT. This representation is compatible with the compiler's `Int`, `Str`,
`Seq(T)`, `Set(T)`, and closed-record evidence grammar and with the
`mirrorecma-v1` native mapping.

Update the safety predicates without weakening them. In particular:

- sequence length is exactly the model universe size;
- every indexed value belongs to its state set;
- a dump slot is associated exactly when it is non-absent;
- consumed tokens map injectively to dump slots and preserve `TokenCase`;
- downloadable equals exactly the available dump slots;
- deleted slots have no blob but retain their case association.

### 3.4 Add one aggregate safety predicate

Define a single operator for MirrorECMA/Apalache configuration:

```tla
SafetyInvariant ==
  /\ TypeOK
  /\ AssociationIntegrity
  /\ TokenIntegrity
  /\ AvailableHasEvidence
  /\ SealedAndQuarantinedHaveEvidence
  /\ NoPrematureBlob
  /\ RejectedIsNotDownloadable
  /\ DeletingIsNotDownloadable
  /\ DeletedHasNoBlob
```

Keep `DumpLedger.cfg` checking the individual invariants so counterexamples
still identify the failed property.

### 3.5 Revalidate the model

Before creating a contract:

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

Update `specs/DumpLedger.svg`, `docs/formal-model.md`, and validation counts in
the same change. Do not carry forward the previous 1,868-state count after the
state representation changes.

## 4. Phase B — define the companion contract

Create `model-interface/DumpLedger.mirror-interface.json` with:

```json
{
  "schema": "mirrors.model-interface/v1",
  "interfaceVersion": "1.0.0",
  "model": {
    "module": "DumpLedger",
    "source": "specs/DumpLedger.tla"
  },
  "wire": {
    "actionVariable": "action_taken",
    "parameterVariable": "parameters"
  }
}
```

The complete file declares these stable actions and projections:

| Stable action ID | Wire action | Inputs from `stepParameters.parameters` |
| --- | --- | --- |
| `Initialize` | `Init` | none |
| `IssueToken` | `IssueToken` | `Token` ← `token` |
| `RevokeToken` | `RevokeToken` | `Token` ← `token` |
| `ExpireToken` | `ExpireToken` | `Token` ← `token` |
| `BeginUpload` | `BeginUpload` | `Token` ← `token`, `Dump` ← `dump` |
| `SealUpload` | `SealUpload` | `Dump` ← `dump` |
| `FailUpload` | `FailUpload` | `Dump` ← `dump` |
| `PromoteObject` | `PromoteObject` | `Dump` ← `dump` |
| `MarkQuarantined` | `MarkQuarantined` | `Dump` ← `dump` |
| `AcceptDump` | `AcceptDump` | `Dump` ← `dump`, `Kind` ← `kind` |
| `RejectDump` | `RejectDump` | `Dump` ← `dump` |
| `BeginPurge` | `BeginPurge` | `Dump` ← `dump` |
| `FinishPurge` | `FinishPurge` | `Dump` ← `dump` |

Declare exactly these implementation observations:

| Stable observation ID | Wire name |
| --- | --- |
| `TokenState` | `tokenState` |
| `TokenDump` | `tokenDump` |
| `DumpPhase` | `dumpPhase` |
| `DumpCase` | `dumpCase` |
| `BlobState` | `blobState` |
| `DigestRecorded` | `digestRecorded` |
| `Validation` | `validation` |
| `Coverage` | `coverage` |
| `Downloadable` | `downloadable` |

Do not declare `action_taken` or `parameters` as observations. The configured
parameter repartition and Mirrors metadata filtering remove them from the
compared SUT state.

Do not assert redundant types in the contract unless Apalache cannot provide a
supported structural type. Trace values validate resolved types; they never
infer or widen them.

## 5. Phase C — build the trace corpus

### 5.1 Checked-in positive traces

Create model-generated ITF traces under `test/fixtures/mbt/traces/`:

```text
01-accepted-partial-delete.itf.json
02-accepted-full-declared-delete.itf.json
03-accepted-unknown-delete.itf.json
04-invalid-rejected-delete.itf.json
05-transfer-failed-delete.itf.json
06-token-revoked-expired.itf.json
```

Use small witness modules under `specs/mbt/` to make Apalache reach each target
branch. Generate the traces through MirrorECMA's `runClientGenTraces`, then
check in the reviewed ITF artifacts. Witness predicates are trace-generation
devices; they do not replace `SafetyInvariant` or weaken the base spec.

The corpus collectively covers all initializer/transition stable IDs and all
three accepted coverage labels. Every trace must have identical:

- `vars`;
- `param_vars`;
- `#meta.varTypes`;
- action/parameter variable spelling.

Keep each artifact below the compiler's current 16 MiB per-trace limit.

### 5.2 Coverage preflight

The preflight command accepts a directory and loads its sorted `.itf.json`
files. Use the positive directory as one corpus:

```sh
/home/nzsn/Repos/Mirrors/.lake/build/bin/model_interface_gen preflight \
  --lock model-interface/DumpLedger.mirror-interface.lock.json \
  --trace test/fixtures/mbt/traces \
  --require-all-actions \
  > model-interface/DumpLedger.mirror-interface.coverage.json
```

Review and commit the canonical coverage report. CI reruns preflight and
byte-compares stdout with the checked-in report; it never repairs the report.

### 5.3 Negative artifacts

Keep malformed or incompatible traces outside the positive directory:

- unknown action;
- transition before initialization;
- wrong token/dump/kind input type;
- missing or extra observation variable;
- duplicate object key;
- mismatched `varTypes` evidence;
- out-of-universe slot;
- corrupt expected digest.

Compiler/preflight tests assert stable error families. Scripted-transport
MirrorECMA tests cover malformed negotiation and binding failures that cannot
occur in a preflight-clean trace.

## 6. Phase D — resolve, generate, and check the port

Use one positive trace as structural evidence; all positive traces must have
the same evidence digest.

```sh
MIRRORS_ROOT=/home/nzsn/Repos/Mirrors

"$MIRRORS_ROOT/.lake/build/bin/model_interface_gen" resolve \
  --spec specs/DumpLedger.tla \
  --contract model-interface/DumpLedger.mirror-interface.json \
  --evidence test/fixtures/mbt/traces/01-accepted-partial-delete.itf.json \
  --param-var parameters \
  --lock model-interface/DumpLedger.mirror-interface.lock.json \
  --diagnostics json

"$MIRRORS_ROOT/.lake/build/bin/model_interface_gen" generate \
  --lock model-interface/DumpLedger.mirror-interface.lock.json \
  --target mirrorecma-v1 \
  --out src/generated/dump-ledger \
  --diagnostics json
```

Expected owned output:

```text
src/generated/dump-ledger/.model-interface-generated.json
src/generated/dump-ledger/DumpLedgerMirror.generated.ts
```

Commit the source, ownership manifest, lock, contract, evidence trace, and
coverage report. Never edit generated output.

CI freshness command:

```sh
"$MIRRORS_ROOT/.lake/build/bin/model_interface_gen" check \
  --spec specs/DumpLedger.tla \
  --contract model-interface/DumpLedger.mirror-interface.json \
  --evidence test/fixtures/mbt/traces/01-accepted-partial-delete.itf.json \
  --param-var parameters \
  --lock model-interface/DumpLedger.mirror-interface.lock.json \
  --target mirrorecma-v1 \
  --out src/generated/dump-ledger \
  --diagnostics json
```

This command is read-only and must fail on stale lock, source, manifest, or
generated bytes.

Compile the generated tree with TypeScript 7 immediately. The generated source
imports public `State`, `Value`, `ApalacheConfig`, and `StateComputer` types from
`mirrorecma`; it must not vendor a second protocol implementation.

## 7. Phase E — implement the real SUT adapter

### 7.1 Harness composition

`MbtHarness` constructs:

- the production lifecycle engine;
- the production SQLite ledger implementation using `:memory:` or a temporary
  database;
- `MemoryVault` for the complete fast trace matrix;
- `ScriptedInspector` for deterministic accept/reject branches;
- deterministic clock, entropy, and identifier adapters;
- slot maps from model customer/case/token/dump integers to real branded IDs;
- counters for factory, engine, observation, and disposal calls.

Selected acceptance traces are repeated with `FilesystemVault` and real
minidump fixtures. Parser/vault adapters retain their own contract suites; the
fast MBT matrix must not depend on multi-gigabyte files.

### 7.2 Generated port adapter

Implement the generated `DumpLedgerPort`; do not implement `StateComputer`
manually.

Conceptual shape, with exact types taken from generated source:

```ts
class DumpLedgerMbtPort implements DumpLedgerPort {
  initialize(): void;
  issueToken(input: IssueTokenInput): void;
  revokeToken(input: RevokeTokenInput): void;
  expireToken(input: ExpireTokenInput): void;
  beginUpload(input: BeginUploadInput): void;
  sealUpload(input: SealUploadInput): void;
  failUpload(input: FailUploadInput): void;
  promoteObject(input: PromoteObjectInput): void;
  markQuarantined(input: MarkQuarantinedInput): void;
  acceptDump(input: AcceptDumpInput): void;
  rejectDump(input: RejectDumpInput): void;
  beginPurge(input: BeginPurgeInput): void;
  finishPurge(input: FinishPurgeInput): void;
  observe(): DumpLedgerObservation;
}
```

TypeScript permits some value-returning functions where `void` is expected.
Prevent accidental async port methods by:

- declaring `: void` explicitly on every class method;
- forbidding `async` in the adapter;
- adding compile-time assertions that each concrete method's `ReturnType` is
  exactly `void`;
- rejecting promise-like observation values at runtime.

Never use `Atomics.wait`, child-process round trips, nested event loops, or
promise polling to simulate synchronous behavior.

### 7.3 Model-slot mapping

- `initialize()` disposes the previous per-trace harness, creates a fresh
  isolated engine, seeds two customers and cases, and clears slot maps.
- `issueToken({token})` calls the real grant operation for
  `TokenCase[token]`, then records the returned grant ID/secret under that model
  token slot.
- `beginUpload({token,dump})` uses the stored real secret, calls the real begin
  operation, and records the returned real dump ID under the dump slot.
- later dump actions resolve the real ID from the slot and call the production
  engine command.
- `acceptDump({dump,kind})` configures the scripted inspector from the model
  input and invokes the real inspection command; production inspection never
  accepts a caller-selected classification.
- `rejectDump({dump})` configures a structural failure and invokes that same
  inspection command.
- `observe()` queries only the real engine/ledger/vault projection, converts
  actual IDs back to stable model slots, and returns every generated
  observation exactly once.

Slot maps are adapter bookkeeping, not an oracle. They may contain only values
returned from earlier SUT calls and model action inputs. They may not contain
expected phases, expected validation, expected coverage, or prior trace state.

## 8. Phase F — register the compiled binding

Use an exact immutable registry entry:

```ts
const adapterId = "dump-ledger-engine/v1";
const semanticDigest = semanticDigestFromHex(DumpLedgerSemanticDigest);

const registry = new CompiledAdapterRegistry([{
  key: {
    semanticDigest,
    adapterId,
    targetProfile: MIRRORECMA_TARGET_PROFILE,
    stateComputerContractVersion: STATE_COMPUTER_CONTRACT_VERSION,
  },
  factory: effectiveConfig => {
    probe.factoryCalls += 1;
    const harness = new MbtHarness();
    const port = new DumpLedgerMbtPort(harness, probe);
    const generated = bindDumpLedger(port, effectiveConfig);
    return {
      semanticDigest,
      computer: generated.computer,
      assertCompatibleConfig: candidate => {
        if (candidate.paramVars !== "parameters") {
          throw new Error("DumpLedger requires paramVars=parameters");
        }
      },
      coverage: generated.coverage,
      dispose: () => harness.dispose(),
    };
  },
}]);
```

The factory must create a fresh binding and harness only after the mirror
returns an exact `matched` reply. `dispose` is idempotent internally but the
runner is expected to call it exactly once.

Use:

```ts
const config: ApalacheConfig = {
  specPath: resolve(repoRoot, "specs/DumpLedger.tla"),
  initPredicate: "Init",
  nextPredicate: "Next",
  invariant: "SafetyInvariant",
  lengthBound: 8,
  paramVars: "parameters",
};

await runClientWithTracesNegotiated(
  process.env.MIRROR_BIN!,
  config,
  positiveTracePaths,
  {
    metadata: DumpLedgerModelInterface,
    adapterId,
    targetProfile: MIRRORECMA_TARGET_PROFILE,
    stateComputerContractVersion: STATE_COMPUTER_CONTRACT_VERSION,
    registry,
    policy: "require",
  },
);
```

`specPath` and trace paths are interpreted by the spawned Mirrors process, so
tests use absolute paths or a controlled common working directory.

## 9. Phase G — mandatory test matrix

### 9.1 Positive MBT

- Replay the full positive trace directory through
  `runClientWithTracesNegotiated` over local stdio.
- Assert `all_steps_done`, exact generated action coverage, and one dispose.
- Assert the adapter observes after every action and never reads previous or
  expected state.
- Exercise all three accepted coverage labels.
- Repeat representative accept/reject/purge paths using real SQLite and the
  filesystem vault.

### 9.2 Negotiation and zero-call failures

For each case below, assert no adapter factory, engine, port, observation, or
dispose call occurs before authorization:

- wrong semantic digest;
- noncanonical digest;
- missing model-interface reply under `require`;
- malformed or mode-inappropriate reply;
- `unsupported`, `unavailable`, or `too_large` under `require`;
- structured registration failure;
- unregistered or ambiguous exact adapter key;
- target-profile or state-computer-contract mismatch;
- unauthorized mTLS principal.

Reuse MirrorECMA's public runner behavior; do not copy its negotiation decoder
into DumpLedger.

### 9.3 Generated-binding failures

- transition before initializer;
- unknown action;
- missing, extra, mistyped, and out-of-universe inputs;
- adapter throws before mutation and after a durable mutation;
- missing, extra, or mistyped observation;
- promise-like value returned from the synchronous adapter;
- permanent binding poisoning after the first generated-binding failure;
- effective `paramVars` mismatch before any port call;
- disposal on success, mismatch, adapter error, transport error, and observer
  error.

These use a scripted MirrorECMA transport where a preflight-clean model trace
cannot express malformed messages.

### 9.4 Ordinary conformance mismatch

Wrap the real observation once to report a deliberately wrong dump phase or
downloadable set after successful negotiation. Require Mirrors to return
ordinary `step_mismatch`, then assert:

- the adapter factory and SUT did run;
- the mismatch contains the expected path;
- no `all_steps_done` follows;
- disposal occurs exactly once.

Do not classify this as negotiation, compiler, or transport failure.

### 9.5 Live trace and mTLS tiers

Two additional gates are required before release:

1. `runClientNegotiated` generates and replays at least one real Apalache trace
   from source through the compiled binding.
2. An allowlisted TLS 1.3 mTLS server replays the checked-in corpus with exact
   digest verification. Missing allowlist authority must cause zero SUT calls.

The deterministic stdio checked-in-trace gate remains always-on. Live Apalache
and mTLS tiers may be separately labeled in local development, but release CI
must run them.

## 10. Commands and final gate

Environment:

```sh
export MIRRORS_ROOT=/home/nzsn/Repos/Mirrors
export MIRRORECMA_ROOT=/home/nzsn/Repos/MirrorECMA
export MIRROR_BIN="$MIRRORS_ROOT/.lake/build/bin/mirror"
```

Build prerequisites:

```sh
lake --dir="$MIRRORS_ROOT" build model_interface_gen mirror
pnpm --dir "$MIRRORECMA_ROOT" run build
pnpm install --frozen-lockfile
```

DumpLedger gate:

```sh
pnpm run typecheck
pnpm run check:model-interface
pnpm run test:unit
pnpm run test:integration
pnpm run test:mbt
pnpm run test:mbt:mtls
```

The gate is green only when:

- TLC and Apalache results are current;
- generated files and semantic lock are byte-current;
- preflight reports no unseen action;
- TypeScript 7 compiles the generated port and handwritten adapter;
- positive MBT reaches `all_steps_done`;
- wrong observation reaches `step_mismatch`;
- every pre-match negative proves zero SUT/factory calls;
- binding/harness cleanup is exactly once; and
- filesystem/parser/crash effects retain their separate acceptance evidence.

## 11. Repository ownership

DumpLedger owns:

- its TLA+ model and witness modules;
- companion contract, semantic lock, coverage report, and trace corpus;
- generated `mirrorecma-v1` tree;
- handwritten application adapter and MBT harness;
- TypeScript 7 compilation and all application acceptance tests.

Mirrors owns:

- resolution, preflight, canonical digests, target lowering, and deterministic
  generated bytes.

MirrorECMA owns:

- negotiation codecs, exact registry selection, `StateComputer` replay,
  cleanup semantics, and transport implementations.

Do not edit Mirrors or MirrorECMA merely to make a DumpLedger test easier. If a
real contract gap is found, reproduce it in the owning repository, change that
repository with its own tests, then update the pinned dependency/revision in a
separate focused change.

## 12. Evidence statement for releases

The release note may state:

> DumpLedger's lifecycle engine passed compiler-preflighted TLA+ trace replay
> through MirrorECMA's negotiated generated binding, including action coverage,
> mismatch detection, zero-call negotiation failures, and cleanup checks.

It must not state that the HTTP stack, SQLite, filesystem, minidump parser, all
crash schedules, or all production inputs are formally verified.
