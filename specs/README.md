# DumpLedger formal specification

`DumpLedger.tla` is a finite executable model of operator-controlled case
workflow, closure-time grant revocation, one-time grant consumption, immutable
case association, crash-sensitive object promotion, validation, availability,
rejection, and purge.

![DumpLedger TLA+ lifecycle](DumpLedger.svg)

Run the complete finite-state exploration with TLC:

```sh
tlc -config specs/DumpLedger.cfg specs/DumpLedger.tla
```

Run a bounded symbolic check with Apalache:

```sh
apalache-mc check \
  --no-deadlock \
  --init=Init \
  --next=Next \
  --inv=SafetyInvariant \
  --length=8 \
  specs/DumpLedger.tla
```

`mbt/` contains falsifiable witness invariants used by MirrorECMA
`runClientGenTraces`. The resulting Apalache traces live under
`test/fixtures/mbt/traces/`; they are generation evidence, not substitutes for
the complete TLC check or bounded `SafetyInvariant` check.

The current case-workflow revision is specification-only. The checked-in model
interface and MBT traces still describe the earlier grant/dump-only model and
must remain visibly stale until the runtime implementation and generated
artifacts are refreshed together.

See `docs/formal-model.md` for the abstraction map and evidence limits.
