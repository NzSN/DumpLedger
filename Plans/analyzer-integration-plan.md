# Analyzer integration execution plan

Derived from [`docs/analyzer-integration-design.md`](../docs/analyzer-integration-design.md).
Covers milestones AI1–AI3; AI4 (query-scoped export, push delivery) stays
deferred until a real consumer needs it. Work is decomposed into waves of
tasks with disjoint file scopes so independent tasks run in parallel.
Milestone dependencies: AI2 builds on AI1's token; AI3 builds on both.

## Conventions for every task

- Follow AGENTS.md: strict TS (`noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`), explicit `.js` extension imports,
  `node:test` + `node:assert/strict`, tests run from `dist/` (build first).
- Contracts package builds first (`pnpm run build` handles ordering).
- Acceptance = scoped tests green + `pnpm run typecheck` clean, plus the
  wave gate.
- Never revert or modify files outside the task's stated scope; unrelated
  uncommitted work must survive untouched.
- Documentation obligations land in the same wave as the capability, not
  later: http-api.md inventory/authentication table, security-model.md token
  section, README environment variables.
- MBT trace regeneration happens only where a wave says so; it is an
  explicit maintainer action, never a side effect of fixing a test.

## Milestone AI1 — catalog read surface

Read-only: no engine commands, no TLA+ action, no projection change. The one
precedent-setting move is ledger read-through (catalog queries hit SQLite
directly, not the in-memory projection); keep it read-only and additive.

### Wave A — contracts and token foundations (parallel)

| Task | Scope (owns) | Delivers |
|---|---|---|
| **A1 catalog contracts** | `packages/http-contracts/src/catalog.ts` (new), `packages/http-contracts/src/index.ts` (append only), `packages/http-contracts/test/catalog.test.ts` (new) | `DumpCatalogParams`/`DumpCatalogEntry`/`DumpCatalogResponse` decode+encode; page cap 200; filter bounds per design table; cursor ≤ 256 non-whitespace chars; `symbolCoverage` counts; optional inspector-fact fields |
| **A2 analyzer token auth** | `src/auth/analyzer-token.ts` (new), `test/unit/analyzer-token.test.ts` (new), `src/main.ts` (additive env wiring only) | `parseAnalyzerTokenHash`/`verifyAnalyzerToken` mirroring ingest-token.ts (digest at rest, constant-time compare, fail-fast boot on malformed `DUMP_LEDGER_ANALYZER_TOKEN_HASH`, unset disables) |

Wave A gate: `pnpm run typecheck && pnpm run build && pnpm run test:unit`.

### Wave B — ledger reads and application (after A1)

| Task | Scope (owns) | Delivers |
|---|---|---|
| **B1 ledger catalog reads** | `src/ledger/migrations.ts` (append migration 7 only), `src/ledger/sqlite-ledger.ts` (additive), `test/integration/ledger-catalog.test.ts` (new) | Migration 7: indexes `dumps(received_at, dump_id)` and `dumps(sha256)`; `searchDumps(filter, cursor)` keyset SQL honoring every design filter; `findDumpsBySha256(hash)`; row → inspector-fact mapping from stored `inspection_facts` JSON |
| **B2 engine read-through + application** | `src/engine/dump-ledger-engine.ts` (read-only additive methods), `src/http/application.ts` (additive), `test/integration/application-catalog.test.ts` (new) | `searchDumps`/`dumpsBySha256` application methods enforcing decoder bounds; bigint → decimal-string shaping per wire convention |

Wave B gate: scoped integration tests green + typecheck.

### Wave C — HTTP wiring (after A2 + B2)

| Task | Scope (owns) | Delivers |
|---|---|---|
| **C1 catalog routes + token guard** | `src/http/routes/dump-catalog-routes.ts` (new), `src/http/routes/dump-routes.ts` (ETag only), `src/http/contracts/json.ts` (additive guard helper), `src/http/server.ts` (registration only), `test/integration/http-catalog-routes.test.ts` (new) | `GET /api/v1/dumps`, `GET /api/v1/dumps/by-sha256/:sha256`; `authorizeSessionOrAnalyzer` helper with pinned bearer precedence; ETag `"<sha256>"` + `If-None-Match` → 304 on `/content`; wrong-token-with-valid-cookie → 401 test; mutation routes still reject the token |

Wave C gate: full `pnpm run test:integration` green.

### Wave D — AI1 docs (with C1)

`docs/http-api.md` (endpoints + `Analyzer` authentication label),
`docs/security-model.md` (analyzer-token section mirroring the CI ingest
bullets), `README.md` (env var). 

AI1 exit: AI1 capabilities demoed end-to-end with curl against a local
instance; `pnpm run test:integration` green.

## Milestone AI2 — event feed

### Wave E — feed contracts and ledger read (parallel)

| Task | Scope (owns) | Delivers |
|---|---|---|
| **E1 events contracts** | `packages/http-contracts/src/events.ts` (new), `index.ts` (append), `test/events.test.ts` (new) | `EventFeedParams`/`EventFeedEntry`/`EventFeedResponse`; `actions` comma-list decode; `limit` default/max 500; `detail` bounded at 4 KiB serialized |
| **E2 audit feed read** | `src/ledger/sqlite-ledger.ts` (additive), `test/integration/ledger-events.test.ts` (new) | `readAuditEvents(afterRowid, filters, limit)` returning `rowid` + projection fields, keyset on `rowid`, action/case filters; beyond-end cursor returns empty page echoing the request cursor |

### Wave F — feed route and docs (after E1 + E2 + C1)

| Task | Scope (owns) | Delivers |
|---|---|---|
| **F1 events route + docs** | `src/http/routes/event-routes.ts` (new), `src/http/application.ts` (additive), `server.ts` (registration), `test/integration/http-event-routes.test.ts` (new), `docs/http-api.md`, `docs/security-model.md` | `GET /api/v1/events` on the analyzer-or-session guard; zero-padded rowid cursor codec (opaque on the wire); feed payload sensitivity review recorded in security-model.md (audit details = identifiers and outcomes, verified against current emitters) |

AI2 exit: a poller can follow intake from cursor 0 to live edge with no
gaps/dupes under concurrent upload, proven by an integration test that
interleaves uploads with paging.

## Milestone AI3 — analysis write-back

The only engine-touching milestone. Spec, engine, and harness land in the
same wave so `check:model-interface` never goes red mid-milestone.

### Wave G — domain, contracts, engine (sequential inside the wave)

| Task | Scope (owns) | Delivers |
|---|---|---|
| **G1 analysis contracts + IDs** | `packages/http-contracts/src/analyses.ts` (new) + test (new), `src/domain/ids.ts` (`analysis_` prefix + `IdentifierKind` extension, additive) | `AnalysisReport`/`RecordAnalysisRequest` shapes per design; identity tuple decoder; `kind` as bounded string (1–64); `summary` ≤ 2000; body within the 16 KiB JSON limit |
| **G2 engine command + ledger** | `src/engine/**`, `src/ledger/migrations.ts` (migration 8 only), `src/ledger/sqlite-ledger.ts` (additive), `test/integration/engine-analysis.test.ts` (new) | `RecordAnalysis` command: dump exists + stable phase + `inputSha256` equals sealed hash; identity-tuple uniqueness → idempotent replay returns existing; audit action `RecordAnalysis`; `dump_analyses` table with cascade on purge; projection addition |

Wave G gate: engine integration tests green + typecheck.

### Wave H — spec and harness (with G2, same PR)

| Task | Scope (owns) | Delivers |
|---|---|---|
| **H1 TLA+ action + MBT binding** | `specs/DumpLedger.tla`, `model-interface/**` (regenerated), `src/mbt/**` (harness binding), `specs/` witnesses (regenerated) | `RecordAnalysis` model action within the existing bounded slots; harness mapping; traces regenerated as an explicit maintainer action and listed separately in the PR per AGENTS.md |

Wave H gate: `pnpm run check:model-interface` + `pnpm run test:mbt` green.

### Wave I — routes, token scope, transfer count (parallel, after G2)

| Task | Scope (owns) | Delivers |
|---|---|---|
| **I1 analysis routes** | `src/http/routes/analysis-routes.ts` (new), `server.ts` (registration), `test/integration/http-analysis-routes.test.ts` (new) | `POST /api/v1/dumps/:dumpId/analyses` (201, 200 on replay; sha mismatch → `invalid_request`), `GET …/analyses`; analyzer-token scope extended to exactly this one mutation |
| **I2 transfer exclusion count** | `src/transfer/manifest.ts` (additive only), `test/unit/manifest.test.ts` (extend) | `skippedAnalyses` count in the export manifest; bundles still exclude report bytes per the design decision |
| **I3 AI3 docs** | `docs/http-api.md`, `docs/security-model.md`, `docs/analyzer-integration-design.md` (status line → implemented) | Inventory rows, write-back scope bullet, decision record |

AI3 exit: full `pnpm test` (typecheck, model-interface check, build, unit,
integration, MBT) green; `pnpm run test:e2e` confirmed unaffected.

## Final integration gate

`pnpm test` plus `pnpm run test:e2e`, run by the integrator after Wave I,
with the PR listing regenerated model-interface and trace artifacts
separately per the repository PR convention.

## Risks

- **Read-through layering precedent** (B1/B2/E2): catalog and feed reads
  bypass the projection. Keep them strictly read-only; any future write
  behind these paths is a design violation.
- **Migration serialization**: migrations 7 and 8 are single-owner (B1, G2
  respectively); no other task touches `migrations.ts`.
- **Token scope creep**: scope is an explicit route allowlist in the guard
  helper; new routes default to session-only and must opt in deliberately.
- **Model churn in AI3**: if the `RecordAnalysis` action forces
  model-interface regeneration beyond expectations, Wave H blocks the
  milestone — do not merge G2/I-tasks alone.
- **Feed payload drift**: new audit emitters added later must honor the
  identifiers-and-outcomes rule; the AI2 security-model note is the
  reviewed invariant.

## Deferred

- AI4: query-scoped export bundles, long-poll `?wait=`, webhooks.
- Web UI display of analysis reports (API-only in v1; when scheduled,
  `facts` render as text, never markup — see the design's security section).
- Per-analyzer distinct token digests (design open question 2).
