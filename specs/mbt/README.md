# MBT trace witnesses

These modules extend `DumpLedger` and add one deliberately falsifiable
invariant apiece. MirrorECMA's `runClientGenTraces` asks Mirrors/Apalache for a
counterexample; reaching the named lifecycle outcome produces the reviewed ITF
trace checked in under `test/fixtures/mbt/traces/`.

The witnesses are trace-generation devices only. They do not replace or weaken
`DumpLedger!SafetyInvariant`, which is checked independently by TLC and
Apalache. `TokensRevokedExpired!WitnessNext` fixes the order of otherwise
independent token actions solely so regenerated evidence is reproducible; the
base specification remains checked against its full `Next` relation.

## Reproducible generation

After compiling DumpLedger and making the `mirrorecma` package available, run:

```sh
MIRROR_BIN=/path/to/Mirrors/.lake/build/bin/mirror \
  node dist/tools/generate-mbt-traces.js
```

The default is a read-only verification mode. The tool calls MirrorECMA
`runClientGenTraces` once for every witness, writes all Mirrors/Apalache output
under a fresh temporary directory, and inspects every returned ITF trace. It
selects only a trace whose terminal action and state satisfy the witness's
specific expected outcome. Zero matching traces fail. Multiple semantically
different matching traces also fail as ambiguous; identical duplicate traces
from the generator are canonicalized and collapsed without relying on path,
filename, directory, or result order.

For the local stdio generator, the tool reads every exact path returned by
MirrorECMA rather than scanning the output directory. Those files are the
Apalache evidence consumed by `model_interface_gen`; inline protocol traces are
only a fallback because protocol decoding may normalize non-semantic metadata.

The selected JSON and reviewed fixture are compared after recursively sorting
object keys and removing Apalache's volatile root `#meta.description`
timestamp. Array order and every model value remain significant. A mismatch
reports the two canonical SHA-256 values and first semantic difference, leaves
the fixture untouched, and exits unsuccessfully. When replacement is explicit,
the canonical fixture omits that volatile timestamp.

Replacing reviewed evidence is deliberately explicit:

```sh
MIRROR_BIN=/path/to/Mirrors/.lake/build/bin/mirror \
  node dist/tools/generate-mbt-traces.js --replace
```

`--replace` writes canonical JSON to the six fixed destination filenames under
`test/fixtures/mbt/traces/`. Review the resulting diff, rerun
`tools/check-model-interface.sh`, and re-run TLC and Apalache before accepting
new evidence. The tool never edits the model-interface lock or generated port.
