# AI1 milestone gate report — Analyzer integration (catalog read surface)

Date: 2026-10-13 · Status: AI1 complete, all six tasks accepted.

## What was delegated and delivered

Task breakdown: `Plans/analyzer-integration-tasks.md` — fine-grained
stage/task/dependency/acceptance tables for AI1–AI3, with per-task file
ownership and exact acceptance commands.

Execution (each task one `general-purpose-flash` agent, `fork_turns="none"`
self-contained briefs, every acceptance independently re-run by the
integrator):

| Task | Result | Verified evidence |
|---|---|---|
| A1 catalog contracts | done | `catalog.ts` + 23 subtests; contracts suite green |
| A2 analyzer token | done | `analyzer-token.ts` mirrors ingest-token; 5/5 unit tests |
| B1 ledger reads + migration 7 | done | Keyset `searchDumps`, `findDumpsBySha256`, indexes; integration 105→109 |
| B2 engine read-through + application | done | Read-only proof test; opaque base64url cursor codec |
| C1 (+C1b) routes/guard/ETag/wiring | done | `authorizeSessionOrAnalyzer`, 2 new GETs, ETag/304; C1b extended the guard to dump detail + content |
| D1 docs | done | http-api.md inventory + `Analyzer` auth label, security-model.md section, README env var |

Incidents handled: the C1 agent stalled ~1h mid-task; it was interrupted, its
already-written work verified independently (it later recovered and
reported), and its scope extended via follow-up. All unrelated worktree state
preserved.

## Gate results (integrator-run)

- typecheck clean · build green · unit 20/20 · integration 116/116 · MBT
  28/28 (socket tests need escalation; the sandbox blocks `listen 127.0.0.1`)
- `check:model-interface` FAILS — pre-existing, unrelated to AI1: the Mirrors
  `model_interface_gen` binary was rebuilt the same day and judges the
  Sep-17 committed bindings stale. All check inputs clean at HEAD; no AI1
  change touched them.

## Known gaps vs the design (agent-flagged, confirmed)

1. Token scope = 4 routes (catalog GETs + dump detail + content).
   Cases/symbols list stay session-only — deliberate; revisited under AI2/AI3.
2. `downloadAuth` audit attribution not implemented (design "Attribution"
   bullet) — needs an `AuthorizeDownload` detail change; follow-up candidate.
3. ETag condition stricter than design text (available + downloadable +
   sha256) — correct behavior; design wording tightened later.

## Next

AI2 (event feed: E1 contracts → E2 ledger read → F1 route). AI3 (analysis
write-back) follows after AI2's gate and includes the TLA+ action + MBT trace
regeneration, an explicit maintainer step per AGENTS.md.
