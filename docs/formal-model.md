# Formal model

## Purpose

`specs/DumpLedger.tla` models the intake lifecycle where association and
storage failures are most dangerous. It is an executable design constraint,
not a model of HTTP, SQLite syntax, filesystem syscalls, cryptographic strength,
or minidump parsing details.

The model uses integer slots `1..2` so TLC and Apalache can enumerate states
quickly. The observable maps are fixed-length sequences and the finite
collections are sets, matching the model-interface compiler's supported
`Seq(T)` and `Set(T)` evidence grammar. Slots stand for arbitrary production
UUIDs and are mapped to real branded identifiers only by the client-local
adapter.

Every state also carries the exact compiler-required `action_taken` label and
a closed `parameters = [case |-> Int, token |-> Int, dump |-> Int,
kind |-> Str]` record.
Unused input positions are reset to `0` or `"unclassified"` on every action so
inputs cannot leak from an earlier step. Neither metadata variable is an
implementation observation.

## Model scope

Included:

- fixed case-to-customer ownership;
- operator-controlled case workflow from `new` through investigation, waiting,
  resolution, closure, and explicit resumption;
- atomic revocation of issued grants at closure and prevention of new grant
  issuance or upload start while a case is closed;
- issue, expiry, revocation, and one-time consumption of upload grants;
- immutable dump-to-case association at upload start;
- streaming, sealing, vault promotion, quarantine, acceptance, rejection, and
  purge;
- separate ledger phase and blob location during crash-sensitive promotion;
- structural validation and coverage classification before availability;
- a non-downloadable `deleting` phase before physical purge;
- retained association and digest evidence after purge.

Excluded:

- creation and deletion of customers and cases; the modeled case slots begin in
  `new`;
- user sessions and role authorization;
- bytes, cryptographic collision resistance, and filesystem contents;
- retention clocks and backup expiry;
- debugger or symbol behavior;
- liveness under a permanently crashed host or absent operator.

These exclusions must be tested or modeled separately before their
implementation is treated as verified.

## State mapping

| TLA+ state | Implementation checkpoint |
| --- | --- |
| `caseStatus[c] = "new"` | case exists and investigation has not started |
| `caseStatus[c] = "investigating"` | operator marked the case active |
| `caseStatus[c] = "waiting-for-customer"` | operator marked customer input pending |
| `caseStatus[c] = "resolved"` | operator recorded an outcome before closure |
| `caseStatus[c] = "closed"` | issued grants revoked; new intake cannot begin |
| `tokenState[t] = "issued"` | hashed grant committed and deliverable |
| `dumpPhase[d] = "receiving"` | dump ID/case association committed; stream active |
| `dumpPhase[d] = "sealed"` | length and original SHA-256 committed |
| `blobState[d] = "vault"` while sealed | rename completed; ledger promotion not yet committed |
| `dumpPhase[d] = "quarantined"` | ledger observes the immutable vault object |
| `dumpPhase[d] = "available"` | validation facts committed; download authorized |
| `dumpPhase[d] = "rejected"` | intake terminal but not downloadable |
| `dumpPhase[d] = "deleting"` | download disabled; byte removal pending or active |
| `dumpPhase[d] = "deleted"` | active bytes absent; tombstone retained |

Stuttering represents a paused or crashed process. Recovery executes the same
idempotent promotion, quarantine, rejection, and purge actions; it receives no
privileged transition that could bypass an invariant.

## Safety properties

### `TypeOK`

Every variable remains within its declared finite domain.

### `AssociationIntegrity`

Every non-absent dump belongs to a known case, every case belongs to one known
customer, and no absent dump has an association. The transition relation never
changes an assigned case or returns a dump ID to `absent`.

### `TokenIntegrity`

A consumed token names exactly one dump, no dump is claimed by two tokens, and
the token's case is the dump's case. Terminal tokens cannot be issued again.

### `ClosedCaseHasNoIssuedGrant`

Every closed case has no issued upload grant. `CloseCase` revokes all issued
grants for its case in the same transition; `IssueToken` and `BeginUpload` are
disabled while the owning case is closed. Consumed grants and in-flight dump
state are unchanged by closure.

### `AvailableHasEvidence`

Every downloadable dump is `available`, has an immutable vault object and
recorded digest, passed structural validation, and has a coverage label.

### `DeletedHasNoBlob`

A deleted dump has neither staging/vault bytes nor download capability. Its
case association and digest evidence remain in the ledger.

Additional invariants check sealed/quarantined evidence, forbid downloads from
rejected dumps, and prevent an object from appearing before the upload is
sealed.

`SafetyInvariant` is the conjunction of all ten named safety predicates. It
is the single predicate used by bounded Apalache and MirrorECMA configuration;
TLC continues to check each named invariant separately for precise
counterexamples.

## What the invariants do not prove

- SHA-256 collision resistance or correct implementation.
- That `fsync` and rename meet the assumed local-filesystem semantics.
- That an accepted dump contains every page expected by the customer.
- Confidentiality of the stored bytes.
- Eventual completion: safety permits stuttering forever after a crash.

The implementation must preserve these evidence boundaries in status text and
documentation.

## Running TLC

From the repository root:

```sh
tlc -config specs/DumpLedger.cfg specs/DumpLedger.tla
```

The checked configuration uses `SafetySpec` and the invariants listed in the
configuration file. Increase the fixed model universe only when the resulting
state space remains tractable.

## Running Apalache

```sh
apalache-mc check \
  --no-deadlock \
  --init=Init \
  --next=Next \
  --inv=SafetyInvariant \
  --length=8 \
  specs/DumpLedger.tla
```

## Running model-interface and MBT checks

The case-workflow revision is intentionally specification-only. Until its
implementation phase regenerates the contract, lock, generated binding, and
traces together, `check:model-interface` and `test:mbt` are expected to reject
the stale pre-revision artifacts. Generated output must not be hand-edited to
hide that mismatch.

After the implementation and regeneration work is complete, run:

```sh
pnpm run check:model-interface
pnpm run build
pnpm run test:mbt
```

`check:model-interface` will use the configured Mirrors `model_interface_gen` to
check the lock and generated `mirrorecma-v1` tree, then preflights the complete
trace directory with `--require-all-actions`. The test tier exercises generated
binding failure behavior, the handwritten adapter, negotiated checked-in trace
replay, and separately gated live Apalache/mTLS acceptance where its external
requirements are present.

TLC and Apalache explore bounded model instances; neither substitutes for a
refinement argument between the TypeScript implementation and this transition
system. Checked-in model-generated traces and the compiler-generated
`DumpLedgerPort` establish the executable conformance seam; the handwritten
adapter may map those inputs only to the real lifecycle engine.

## Validation record

On 2026-09-05, the specification-only case-workflow revision produced:

- TLC 2.19: complete state graph, 515,075 states generated, 99,143 distinct
  states, depth 23, and no invariant violation;
- Apalache 0.57.0: Snowcat type checking passed and `SafetyInvariant` had no
  counterexample through computation length 8 (`EXITCODE: OK`).

The prior implementation-aligned model had six MirrorECMA traces covering 47
states and all 13 prior action IDs at semantic digest
`edefb258a6c1e4e2f8aa5103c468401b8a94125b8e51011653407e521fb10b45`.
Those contract, lock, generated binding, trace, and coverage artifacts are now
intentionally stale. They are not evidence for `caseStatus` or the five new
case actions and will be regenerated only during the later implementation
phase.

TLC was configured not to report deadlock because terminal combinations of
expired/revoked grants and completed dumps are legitimate. This does not assert
liveness; `SafetySpec` explicitly permits stuttering.

## Refinement link

The generated source and manifest under `src/generated/dump-ledger/` are owned
by Mirrors `model_interface_gen`; handwritten code must not patch generated
dispatch, conversion, observation, coverage, or poisoning behavior. The MBT
adapter under `src/mbt/` implements only the generated `DumpLedgerPort`, maps
finite slots to real branded IDs, and invokes the production lifecycle engine.
The checked-in generated tree currently describes the pre-case-workflow model
and remains stale by design until implementation begins.

The compiler-owned `StateComputer` contract is synchronous. Generated action
methods, the handwritten adapter, engine transitions, and observations must
therefore finish synchronously; asynchronous HTTP upload streaming completes
outside this seam before `SealUpload` and later lifecycle actions are driven.
The adapter never receives expected trace state and must not use
`StateComputer.prevState`.

MirrorECMA compares the engine's observable projection with the checked trace.
Production audit rows are security records and are not reused as a claim of
formal conformance. No current result is a proof that HTTP, SQLite, filesystem,
cryptography, minidump bytes, or the overall application refines the TLA+
model for all inputs and environments.
