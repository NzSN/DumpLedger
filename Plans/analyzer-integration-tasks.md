# Analyzer integration — fine-grained tasks

Derived from [`analyzer-integration-plan.md`](analyzer-integration-plan.md)
and [`../docs/analyzer-integration-design.md`](../docs/analyzer-integration-design.md).
Execution via delegated `general-purpose-flash` agents; one agent per task,
disjoint file ownership, `fork_turns="none"` with self-contained briefs.

## Delegation conventions (all tasks)

- Agents receive: repo path, design/plan doc paths to read first, exact owned
  files, AGENTS.md conventions, scoped build/test commands, report format.
- **Build discipline (parallel safety)**: contracts work builds only
  `packages/http-contracts` (`pnpm --filter @dump-ledger/http-contracts …`);
  backend work builds only the root tsconfig (`pnpm run build:contracts &&
  tsc -p tsconfig.json`). Nobody runs root `pnpm run build` or `pnpm test`
  during parallel waves — the integrator runs full gates.
- Agents are told they share the worktree with other agents and the
  integrator: touch only owned files; never revert foreign edits; unrelated
  dirty work (`git status`) is not theirs.
- Wave gates are run by the integrator, not self-reported: typecheck, build,
  scoped tests, then the wave's full tier.
- Status: ☐ pending · ◐ assigned · ● accepted.

## Stage AI1 — catalog read surface

| ID | Task | Depends on | Status |
|---|---|---|---|
| A1 | Catalog contracts | — | ● |
| A2 | Analyzer token module | — | ● |
| B1 | Ledger catalog reads + migration 7 | A1 | ● |
| B2 | Engine read-through + application | A1, B1 | ● |
| C1 | Catalog routes, token guard, ETag, wiring | A2, B2 | ● |
| D1 | AI1 documentation | C1 | ● |

### A1 — Catalog contracts

- **Owns**: `packages/http-contracts/src/catalog.ts` (new),
  `packages/http-contracts/src/index.ts` (append-only re-export),
  `packages/http-contracts/test/catalog.test.ts` (new).
- **Deliver**:
  1. `DumpCatalogParams` decoder from `Record<string, string | readonly
     string[] | undefined>`: optional `caseId`, `customerId`, `phase`,
     `validation`, `receivedAfter`, `receivedBefore`, `architecture` (≤64),
     `exceptionCode` (uint32 JSON number semantics), `sha256` (64 lowercase
     hex), `cursor` (≤256 non-whitespace); each parameter at most once
     (array values reject); unknown keys reject; mirrors
     `decodeCaseSearchParams` conventions in `cases.ts`.
  2. `DumpCatalogEntry` / `DumpCatalogResponse` symmetric decode+encode per
     design §"Response rows": `byteSize`/`exceptionAddress` decimal strings,
     `sha256` nullable lowercase hex, canonical ISO timestamps, optional
     `architecture`/`exceptionCode`, `symbolCoverage` counts `{present,
     missing, unidentified}`, optional `nextCursor`.
  3. Exported `MAX_CATALOG_PAGE = 200`.
- **Acceptance**: `pnpm --filter @dump-ledger/http-contracts test` green;
  `pnpm run typecheck:contracts` clean; round-trip property: every encoded
  response decodes to the same value.

### A2 — Analyzer token module

- **Owns**: `src/auth/analyzer-token.ts` (new),
  `test/unit/analyzer-token.test.ts` (new). Wiring (`main.ts`, server
  options) belongs to C1 — do not touch here.
- **Deliver**:
  1. `parseAnalyzerTokenHash(value: string | undefined): Buffer | undefined`
     — undefined/empty disables; otherwise exactly 64 lowercase hex or throw
     (boot fail-fast), mirroring `src/auth/ingest-token.ts`.
  2. `verifyAnalyzerToken(configuredHash, token)` — constant-time digest
     compare; always false while disabled.
  3. Unit tests: disabled, malformed env, match, mismatch, non-Bearer-shaped
     inputs never throw.
- **Acceptance**: `pnpm run build:contracts && tsc -p tsconfig.json && node
  --test dist/test/unit/analyzer-token.test.js` green; backend typecheck
  clean.

### B1 — Ledger catalog reads + migration 7

- **Owns**: `src/ledger/migrations.ts` (append migration 7 only),
  `src/ledger/sqlite-ledger.ts` (additive),
  `test/integration/ledger-catalog.test.ts` (new).
- **Deliver**:
  1. Migration 7: `CREATE INDEX dumps_received_idx ON dumps(received_at,
     dump_id);` and `CREATE INDEX dumps_sha256_idx ON dumps(sha256);`
     (existing columns; `purge_at`/`dumps_purge_due_idx` precedent in
     migration 2).
  2. `searchDumps(filter, cursor)`: keyset `WHERE (received_at, dump_id) >
     (:r, :d) ORDER BY received_at, dump_id LIMIT 201` → 200-row page +
     opaque nextCursor; every A1 filter as optional AND clause.
  3. `findDumpsBySha256(hash)`.
  4. Row mapping including `inspection_facts_json` → `architecture`,
     `exceptionCode` (number), `exceptionAddress` (bigint); absent/failed
     inspection → fields absent.
- **Acceptance**: integration test seeds a ledger covering the filter matrix
  and proves gapless, duplicate-free paging with inserts interleaved between
  pages; `pnpm run build:contracts && tsc -p tsconfig.json && node --test
  dist/test/integration/ledger-catalog.test.js` green.

### B2 — Engine read-through + application

- **Owns**: `src/engine/dump-ledger-engine.ts` (read-only additive methods),
  `src/http/application.ts` (additive),
  `test/integration/application-catalog.test.ts` (new).
- **Deliver**:
  1. Engine read-through `searchDumps`/`dumpsBySha256` delegating to the
     ledger — no command, no audit event, no projection change.
  2. Application `searchDumps(params): DumpCatalogResponse` and
     `dumpsBySha256(hash)` shaping to A1 contract types (bigint → decimal
     string; null discipline per design).
- **Acceptance**: application-level integration test green over the real
  engine + SQLite ledger; backend typecheck clean.

### C1 — Catalog routes, token guard, ETag, wiring

- **Owns**: `src/http/routes/dump-catalog-routes.ts` (new),
  `src/http/contracts/json.ts` (additive guard helper only),
  `src/http/server.ts` (route registration + additive
  `HttpServerOptions.analyzerTokenHash` field), `src/main.ts` (additive env
  wiring), `src/http/routes/dump-routes.ts` (ETag/304 on `/content` only),
  `test/integration/http-catalog-routes.test.ts` (new).
- **Deliver**:
  1. `authorizeSessionOrAnalyzer(request, reply, options)`: any
     `Authorization` header → bearer-only path (malformed/wrong/disabled =
     generic 401, never cookie fallback); otherwise the existing session
     guard. Mirrors `authorizeSymbolIngest` precedence discipline.
  2. `GET /api/v1/dumps` and `GET /api/v1/dumps/by-sha256/:sha256`.
  3. Strong `ETag: "<sha256>"` + `If-None-Match` → 304 on
     `GET /api/v1/dumps/:dumpId/content`; `Cache-Control: no-store`
     unchanged.
  4. Wiring: `DUMP_LEDGER_ANALYZER_TOKEN_HASH` parsed in `main.ts` into
     server options.
  5. Tests: token precedence (wrong token + valid cookie → 401); token
     rejected on every mutation route; catalog filter/pagination over HTTP;
     ETag 304.
- **Acceptance**: full `pnpm run build:contracts && tsc -p tsconfig.json &&
  pnpm run test:integration` green.

### D1 — AI1 documentation

- **Owns**: `docs/http-api.md`, `docs/security-model.md`, `README.md`.
- **Deliver**: inventory rows for the three new GETs; `Analyzer` row in the
  authentication label table; analyzer-token section mirroring the CI ingest
  bullets (disabled-by-default, scope, precedence, digest-at-rest, rotation);
  README env var.
- **Acceptance**: integrator review against the implemented routes.

## Stage AI2 — event feed (complete; gate passed 2026-10-13)

| ID | Task | Depends on | Status |
|---|---|---|---|
| E1 | Events contracts | — | ● |
| E2 | `readAuditEvents` ledger read | — | ● |
| F1 | Events route + guard + docs | E1, E2 | ● |

### E1 — Events contracts

- **Owns**: `packages/http-contracts/src/events.ts` (new),
  `packages/http-contracts/src/index.ts` (append-only),
  `packages/http-contracts/test/events.test.ts` (new).
- **Deliver**:
  1. `decodeEventFeedParams` from the query bag: optional `since` (opaque
     cursor, ≤ 256 non-whitespace), `actions` (comma-separated; each action
     1–64 chars; list ≤ 32 entries), `caseId` (identifier shape), `limit`
     (integer 1–500; absent → 500). Each parameter at most once; unknown
     keys reject; mirrors `decodeDumpCatalogParams` conventions.
  2. `EventFeedEntry` / `EventFeedResponse` symmetric decode+encode: entry =
     `{ cursor: string, eventId, occurredAt, action (1–64), customerId |
     null, caseId | null, dumpId | null, detail }` where `detail` is a JSON
     object bounded at 4 KiB serialized (add a bounded-JSON helper locally if
     `decode.ts` lacks one); response = `{ events: [...] (array bound 4096),
     nextCursor: string }` — `nextCursor` ALWAYS present (feed semantics:
     beyond-end pages echo the request position).
  3. Exported `MAX_EVENTS_PAGE = 500`, `MAX_EVENT_DETAIL_BYTES = 4096`.
- **Acceptance**: `pnpm --filter @dump-ledger/http-contracts test` green;
  `pnpm run typecheck:contracts` clean; encode→decode round-trip equality;
  bound-violation coverage.

### E2 — `readAuditEvents` ledger read

- **Owns**: `src/ledger/sqlite-ledger.ts` (additive),
  `test/integration/ledger-events.test.ts` (new). No migration (rowid is
  inherent).
- **Deliver**:
  1. Exported `AuditFeedEntry` = `{ rowid: number, eventId, occurredAt,
     action, customerId | null, caseId | null, dumpId | null, detail }` and
     method `readAuditEvents(afterRowid?: number, filter?: { actions?:
     readonly string[]; caseId?: CaseId }, limit?: number)` returning
     `{ events, lastRowid }`: `WHERE rowid > ?` when afterRowid present,
     optional `action IN (...)`, `case_id = ?`, `ORDER BY rowid`, limit
     clamped to [1, 500]; `lastRowid` = last delivered rowid, else the
     incoming afterRowid, else 0. Reuse the existing audit row mapping from
     `snapshot()`.
  2. Integration test seeding audit rows via real engine commands: full scan
     from 0; actions filter; caseId filter; gapless/duplicate-free paging
     with inserts between pages; beyond-end echo; empty ledger → empty + 0.
- **Acceptance**: `pnpm run build:contracts && tsc -p tsconfig.json && node
  --test dist/test/integration/ledger-events.test.js` green; backend
  typecheck clean; full unit + integration tiers green.

### F1 — Events route + guard + docs

- **Owns**: `src/http/routes/event-routes.ts` (new), `src/http/application.ts`
  (additive), `src/engine/dump-ledger-engine.ts` (read-only additive),
  `src/http/server.ts` (registration + port method), `test/integration/http-event-routes.test.ts` (new),
  `docs/http-api.md`, `docs/security-model.md`.
- **Deliver**: `GET /api/v1/events` under `authorizeSessionOrAnalyzer`;
  application `eventFeed(params)` with opaque cursor codec (zero-padded
  rowid, 16 digits, validated on decode); token scope docs updated (the
  D1-written 4-route lists grow to 5); inventory row; endpoint section;
  security-model feed-sensitivity note (identifiers-and-outcomes invariant).
- **Acceptance**: full integration tier green incl. token-precedence and
  beyond-end-echo tests over HTTP.

## Stage AI3 — analysis write-back (complete; gate passed 2026-10-14: full `pnpm test` + e2e 13/13)

Toolchain decision (2026-10-13, user): **option 1** — model-interface
bindings were regenerated against the current Mirrors compiler as a pure
drift-absorption baseline BEFORE any AI3 spec change (6 files under
`src/generated/`); `pnpm test` fully green from that baseline. Wave H's later
regen therefore contains only the `RecordAnalysis` interface delta.

| ID | Task | Depends on | Status |
|---|---|---|---|
| G1 | Analysis contracts + `analysis_` ID kind | — | ● |
| G2 | `RecordAnalysis` engine command + migration 8 | G1 | ● |
| H1 | TLA+ action + model-interface regen + MBT harness + traces | G2 | ● |
| I1 | Analysis routes; token scope +1 POST | G2, H1 | ● |
| I2 | Export manifest `skippedAnalyses` count | G2 | ● |
| I3 | AI3 docs + design status flip | I1, I2 | ● |

### G1 — Analysis contracts + IDs

- **Owns**: `packages/http-contracts/src/analyses.ts` (new),
  `packages/http-contracts/src/index.ts` (append-only),
  `packages/http-contracts/test/analyses.test.ts` (new),
  `src/domain/ids.ts` (additive: `AnalysisId`, `parseAnalysisId`,
  `IdentifierKind`/`IdSource` "analysis" kind + mechanical fixes to IdSource
  implementers), `test/unit/` id-parse coverage (additive).
- **Deliver** per design "Analysis write-back": `RecordAnalysisRequest`
  (analyzer `{name, version}` bounded text, `kind` 1–64, `inputSha256`
  64-hex, `outcome` "completed"|"failed", `summary` ≤2000, optional bounded
  `facts`, optional `duplicateOf` dumpId|null) and `AnalysisReport`
  (request fields + `analysisId`, `dumpId`, `createdAt`); `GET` response
  `{ analyses: [...] }` with 4096 array bound; `MAX_ANALYSES_PER_DUMP` bound
  for the route layer.
- **Acceptance**: `pnpm --filter @dump-ledger/http-contracts test`;
  `pnpm run build:contracts && tsc -p tsconfig.json && node --test
  dist/test/unit/` green.

### G2 — `RecordAnalysis` engine command + migration 8

- **Owns**: `src/engine/**` (command type, validation, execution),
  `src/ledger/migrations.ts` (append migration 8 only),
  `src/ledger/sqlite-ledger.ts` (additive), `src/engine/projection.ts`
  (additive), `test/integration/engine-analysis.test.ts` (new).
- **Deliver**: `dump_analyses` table (identity tuple UNIQUE: dump_id,
  analyzer_name, analyzer_version, kind, input_sha256; cascade on dump
  purge); `RecordAnalysis` command — dump exists + stable phase +
  inputSha256 equals sealed hash, idempotent replay returns the existing
  report; audit action `RecordAnalysis` (surfaces on the AI2 feed for free);
  projection addition for read paths.
- **Acceptance**: engine integration tests green; full unit+integration
  tiers green.

### H1 — TLA+ action + harness (with G2, same PR)

- **Owns**: `specs/DumpLedger.tla`, `model-interface/**` (regenerated),
  `src/mbt/**` (harness binding), `test/fixtures/mbt/**` (regenerated
  traces), `src/generated/**` (regenerated bindings).
- **Deliver**: `RecordAnalysis` model action within the existing bounded
  slots; regenerated model-interface bindings + MBT traces as the explicit
  maintainer action (option-1 baseline already absorbed); harness mapping +
  MBT suite green.
- **Acceptance**: `pnpm run check:model-interface` + `pnpm run test:mbt`
  green.

### I1 — Analysis routes (after G2 + H1)

- **Owns**: `src/http/routes/analysis-routes.ts` (new),
  `src/http/server.ts` (registration + port), `src/http/application.ts`
  (additive), `test/integration/http-analysis-routes.test.ts` (new),
  `docs/http-api.md` scope paragraph (5 → 6 routes).
- **Deliver**: `POST /api/v1/dumps/:dumpId/analyses` (201; 200 on idempotent
  replay; sha mismatch → invalid_request) and `GET
  /api/v1/dumps/:dumpId/analyses`; analyzer token scope extended to exactly
  this POST; mutation guard for session callers (CSRF) with bearer
  precedence per the established pattern.

### I2 — Export manifest `skippedAnalyses` count (after G2)

- **Owns**: `src/transfer/manifest.ts` (additive), `test/unit/manifest.test.ts`
  (extend), plus the transfer export writer site that populates the manifest.
- **Deliver**: `skippedAnalyses` count in export manifests; bundles still
  exclude report bytes (design decision).

### I3 — AI3 docs + design status flip (after I1 + I2)

- **Owns**: `docs/http-api.md`, `docs/security-model.md`,
  `docs/analyzer-integration-design.md` (status line → implemented
  milestones), `CONTEXT.md` if vocabulary shifts.

Gate: full `pnpm test` + `pnpm run test:e2e` by integrator; regenerated
model-interface/trace artifacts listed separately in the PR per AGENTS.md.
