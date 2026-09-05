# DumpLedger implementation drafts

Status: mixed historical and active design material. The 2026-09-04 plans
record the baseline that was subsequently implemented. Each newer document
states its own implementation status and must not be read as a shipped claim.

## Plans

- [`typescript7-implementation-plan.md`](typescript7-implementation-plan.md)
  defines the production module shape, TypeScript 7 and Node.js toolchain,
  persistence/vault design, delivery order, and acceptance gates.
- [`mirrorecma-mbt-plan.md`](mirrorecma-mbt-plan.md) defines the required TLA+
  changes, model-interface compiler artifacts, generated port, handwritten
  DumpLedger adapter, MirrorECMA runner, trace corpus, and negative matrix.
- [`vite-react-typescript7-frontend-design.md`](vite-react-typescript7-frontend-design.md)
  defines the proposed Vite 8, React 19, and TypeScript 7 browser application,
  its same-origin Fastify HTTP interface, security rules, migration sequence,
  ownership slices, and acceptance gates. It is design-only.

Read the MBT plan before implementing the lifecycle engine. It exposes three
constraints that affect the production shape rather than merely adding tests at
the end.

## Grounded repository snapshot

The plans were checked against these local revisions on 2026-09-04:

- Mirrors `247e4de` (`feat: add MirrorCPP model-interface target`);
- MirrorECMA `0d8f0ec` (`feat: add dynamic model-interface descriptors`);
- DumpLedger's current design documents and `specs/DumpLedger.tla`.

Re-check the referenced interfaces before implementation. The authoritative
compiler and runtime sources are:

- `/home/nzsn/Repos/Mirrors/tools/ModelInterfaceGen.lean`;
- `/home/nzsn/Repos/Mirrors/Core/ModelInterface/Resolve.lean`;
- `/home/nzsn/Repos/Mirrors/Shell/ModelInterface/Evidence.lean`;
- `/home/nzsn/Repos/Mirrors/Docs/generated-model-interface-spec.md`;
- `/home/nzsn/Repos/MirrorECMA/src/negotiated.ts`;
- `/home/nzsn/Repos/MirrorECMA/src/protocol.ts`.

## Fixed decisions

1. DumpLedger is implemented in TypeScript 7 and runs on Node.js 24 LTS.
2. The first deployment is one process, one SQLite ledger, and one local
   encrypted filesystem vault. Operators never use SQLite directly.
3. The lifecycle engine is exercised through MirrorECMA MBT. Directly comparing
   a second handwritten state machine to TLA+ is not an acceptable substitute.
4. Mirrors `model_interface_gen --target mirrorecma-v1` generates the typed
   application port and `StateComputer` binding. Generated files are committed,
   checked for freshness, and never hand-edited.
5. The executable DumpLedger adapter remains client-local and calls the real
   lifecycle engine. It never copies expected state or reimplements TLA+
   transition logic.
6. MBT uses compiled `verify` negotiation with policy `require`. Dynamic
   descriptor mode is outside the production plan.
7. MirrorECMA's existing synchronous `StateComputer` seam remains unchanged.
8. SQLite writes, vault promotion, inspection, and purge remain distinct
   durable checkpoints so crash recovery cannot publish incomplete bytes.

## Blocking mismatches in the current TLA+ model

`specs/DumpLedger.tla` is model-checkable but cannot yet be consumed by the
version-1 model-interface compiler as a usable DumpLedger port:

1. The compiler requires the action variable to be named exactly
   `action_taken`; the model currently uses `actionTaken`.
2. Action choices (`t`, `d`, and `kind`) are not persisted in a configured
   parameter variable, so a generated adapter cannot know which real operation
   to perform.
3. The compiler's current ITF evidence parser accepts scalar, set, sequence,
   tuple, and closed-record types, but not the model's `Str -> Str` function
   annotations.
4. Generated `mirrorecma-v1` port methods and `StateComputer` are synchronous.
   An adapter cannot return promises, hide asynchronous work, or block the Node
   event loop waiting for its own promises.

The MBT plan resolves all four before generation begins.

## Definition of implementation-ready

Implementation may begin when:

- the two plans have no unresolved semantic choice affecting persisted data;
- the compiler-compatible TLA+ revision passes TLC and Apalache again;
- a representative ITF trace resolves a semantic lock successfully;
- the generated port compiles under TypeScript 7 without edits;
- the chosen MirrorECMA dependency is pinned reproducibly; and
- an open-source `LICENSE` has been selected and committed.
