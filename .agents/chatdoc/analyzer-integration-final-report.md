# Analyzer integration — final report (AI1 + AI2 + AI3 complete)

Dates: 2026-10-13 → 2026-10-14 · Status: all three milestones delivered and
verified; full `pnpm test` + e2e green. Commit `98e484c`.

## What DumpLedger offers an external analyzer

| Capability | Endpoint | Auth |
|---|---|---|
| Catalog search (filters: case/customer/phase/validation/received range/architecture/exceptionCode/sha256; keyset pages of 200) | `GET /api/v1/dumps` | Analyzer token or session |
| Duplicate lookup | `GET /api/v1/dumps/by-sha256/:sha256` | Analyzer token or session |
| Dump detail (phase, sha256, validation, symbolCoverage) | `GET /api/v1/dumps/:dumpId` | Analyzer token or session |
| Byte retrieval with strong ETag + 304 revalidation | `GET /api/v1/dumps/:dumpId/content` | Analyzer token or session |
| Resumable audit event feed (rowid cursor, actions/case filters, 500/page, beyond-end echo) | `GET /api/v1/events` | Analyzer token or session |
| Analysis write-back (idempotent on identity tuple; replay → 200) | `POST /api/v1/dumps/:dumpId/analyses` | Analyzer token or session+CSRF |
| Analysis listing | `GET /api/v1/dumps/:dumpId/analyses` | Analyzer token or session |
| Symbol resolution (pre-existing) | `GET /symbols/:name/:id/:file` | Public |

Analyzer token: `DUMP_LEDGER_ANALYZER_TOKEN_HASH` (sha256 digest at rest,
disabled when unset, pinned bearer precedence, rotation by restart).

## Execution summary (all via general-purpose-flash agents)

- AI1 (6 tasks): catalog contracts · token module · ledger keyset reads +
  migration 7 · application layer · routes/guard/ETag (+C1b scope extension
  to dump detail/content) · docs.
- AI2 (3 tasks): events contracts · `readAuditEvents` ledger read · events
  route + docs.
- AI3 (6 tasks): analysis contracts + `analysis_` IDs · `RecordAnalysis`
  engine command + migration 8 (`dump_analyses`, purge cascade) · TLA+ action
  + interface/bindings/traces regen · routes + write-back guard · export
  manifest `skippedAnalyses` · docs + CONTEXT.md vocabulary.
- Toolchain decision: option 1 — bindings regenerated against the current
  Mirrors compiler as a clean drift-absorbing baseline before the spec
  change.

## Incidents and integrator completions

1. C1 agent stalled ~1h mid-task: interrupted, work verified independently;
   it later recovered and reported.
2. H1 agent vanished after its edits (no final report). The integrator
   completed the DumpLedgerTransfer ripple: `analysisRecorded` added to 28
   UNCHANGED lists in the transfer spec, the transfer interface observation,
   transfer trace regeneration (`--replace`, authorized), all four negative
   fixtures backfilled, and the transfer harness + suite-adapter observation
   mappings.
3. Pre-existing environment findings: socket-binding tests need escalated
   runs (sandbox EPERM); TLC full model check exceeds the 570s smoke bound
   as usual.

## Final gate (integrator-run, 2026-10-14)

- typecheck clean · build green · `check:model-interface` clean (both specs,
  coverage, negative diagnostics, suite bundles)
- unit 149/149 · integration 143/143 · MBT 28/28 · e2e 13/13
- 78 files changed (+1905/−196), incl. regenerated bindings/traces listed
  separately per repo convention.

## Known follow-ups (documented in the design doc)

- `downloadAuth` audit attribution on `AuthorizeDownload` — unimplemented.
- Case manifest not in token scope (open question 1, resolved-in-v1).
- AI4 deferred: query-scoped export, long-poll/webhooks; per-analyzer
  digests; web UI for analysis reports.
