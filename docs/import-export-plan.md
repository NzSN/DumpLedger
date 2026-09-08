# Import/export execution plan

Derived from [`import-export-design.md`](import-export-design.md). Covers IE1–IE3;
IE4 hardening stays deferred. Work is decomposed into waves of tasks with
disjoint file scopes so independent tasks run in parallel.

## Conventions for every task

- Follow AGENTS.md: strict TS, `.js` extension imports, `node:test` +
  `assert/strict`, tests run from `dist/` (build first).
- Contracts package builds first (`pnpm run build` handles ordering).
- Acceptance = scoped tests green + `pnpm run typecheck` clean.
- The repo has unrelated uncommitted changes (trustProxy fix, docs). Never
  revert or "clean up" files outside your scope.

## Wave A — foundations (parallel)

| Task | Scope (owns) | Delivers |
|---|---|---|
| **A1 tar module** | `src/transfer/tar.ts`, `test/unit/tar.test.ts` (new files only) | Streaming ustar writer (regular files only, GNU base-256 for ≥8 GiB, deterministic mtime) + strict reader (rejects non-regular typeflags, pax, absolute/`..` paths, duplicates, bad checksums, truncation; bounded entries/bytes; names ≤ 100 bytes) |
| **A2 HTTP contracts** | `packages/http-contracts/src/transfer.ts` + `test/transfer.test.ts` (new), `src/index.ts` (append export only) | Runtime-decoded types for the 6 operations endpoints from the design (export create/list/download/delete, import create/progress), mirroring existing module patterns |
| **A3 engine import commands** | `src/engine/**`, `src/ledger/**`, `src/domain/**` (additive), `test/integration/engine-import.test.ts` (new) | `BeginImport` (refuses non-empty ledger), `ImportCustomer`, `ImportCase`, `ImportGrant(record, forcedState?)`, `ImportDumpStaged`, `FinishImport`; `grantKeyFingerprint()`; audit actions; original IDs/timestamps preserved |

Wave A gate: `pnpm run typecheck && pnpm run build && pnpm run test:unit` +
scoped engine/tar tests green.

## Wave B — pipelines and UI (parallel, after A)

| Task | Scope (owns) | Delivers |
|---|---|---|
| **B1 transfer pipelines** | `src/transfer/` (except `tar.ts`), `test/integration/transfer-roundtrip.test.ts` (new) | `manifest.ts` (schema + codecs), `export.ts` (online backup → tar stream → atomic seal into `data/exports/<id>/`), `import.ts` (strict read → fingerprint policy → per-entity engine commands → vault staging/promote reuse → inspection → accept/reject), `manager.ts` (one-at-a-time job state) |
| **B2 operations UI** | `frontend/src/**` only | Export/Import section on the operations page: create export, list, download, delete, import-by-server-path with strict confirmation, progress polling; vitest coverage mirroring existing feature tests |

Wave B gate: round-trip integration test green (export → wipe → import →
byte-identical download), web build + vitest green.

## Wave C — HTTP wiring (after B1)

| Task | Scope (owns) | Delivers |
|---|---|---|
| **C1 routes + wiring** | `src/http/routes/transfer-routes.ts` (new), `src/http/server.ts` + `src/http/application.ts` + `src/main.ts` (additive only — trustProxy edits must survive), `test/integration/http-transfer-routes.test.ts` (new) | The 6 endpoints from the design: operator-only via `jsonRequireMutation`, streamed download (no buffering), 409 while a job runs, import path validated (regular file, no symlinks) |

Wave C gate: full `pnpm run test:integration` green.

## Wave D — browser journey (after B2 + C1)

| Task | Scope (owns) | Delivers |
|---|---|---|
| **D1 e2e** | `e2e/**` only | Playwright journey: upload → export → download bundle → import into a fresh second instance → byte-identical download; tampered bundle rejected |

## Final integration gate

`pnpm test` (typecheck, model-interface check, build, unit, integration, MBT)
plus `pnpm run test:e2e`, run by the integrator after Wave D.

## Risks

- **Engine surface gaps** discovered by B1/C1: additive-only changes allowed,
  must be flagged in the task report.
- **Contract drift** between A2 and consumers: B/C tasks compile against the
  built contracts; typecheck at each gate catches drift.
- **Import transition legality**: A3 owns lifecycle additions; imported dumps
  must reach `available` only through quarantine + inspection, never directly.
