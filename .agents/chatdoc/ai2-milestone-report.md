# AI2 milestone gate report — Analyzer integration (event feed)

Date: 2026-10-13 · Status: AI2 complete, all three tasks accepted.

## What was delegated and delivered

| Task | Delivered | Evidence |
|---|---|---|
| E1 events contracts | `packages/http-contracts/src/events.ts` — query-bag decoder (`since`/`actions`/`caseId`/`limit`), symmetric entry/response pairs, 4 KiB detail bound (UTF-8 byte-exact tests), `MAX_EVENTS_PAGE = 500` | contracts suite green (26 events tests) |
| E2 ledger read | `readAuditEvents(afterRowid?, filter?, limit?)` — rowid keyset, `action IN` / `case_id` filters, `lastRowid` beyond-end echo; 7 integration tests | integration 116→123 |
| F1 route + guard + docs | `GET /api/v1/events` under `authorizeSessionOrAnalyzer`; zero-padded-rowid opaque cursor; docs updated (inventory, endpoint section, token scope 4→5 routes, feed-sensitivity note) | integration 125, incl. precedence + gapless paging over interleaved writes |

## Gate results (integrator-run)

- typecheck clean · build green
- unit 20/20 · integration 125/125 · MBT 28/28 · contracts 137/137 subtests
- `check:model-interface` still fails for the known pre-existing reason
  (Mirrors compiler rebuilt vs Sep-17 committed bindings; no AI1/AI2 change
  touched any of its inputs)

## The analyzer loop served by AI1+AI2

1. Discover — `GET /api/v1/dumps` (filters, keyset pages)
2. Follow changes — `GET /api/v1/events?since=<cursor>` (resumable feed)
3. Retrieve — `GET /api/v1/dumps/:id` and `/content` (ETag-revalidatable)
4. Symbols — `GET /symbols/:name/:id/:file` (symsrv-compatible, public)

All catalog/event/dump reads accept the analyzer bearer token — no cookie
session automation needed.

## Next: AI3 decision point

AI3 (analysis write-back) Wave H gate runs `check:model-interface`, blocked
by the pre-existing toolchain drift. Options: (1) regenerate bindings against
the current Mirrors compiler as part of Wave H (absorbs drift); (2) rebuild
the matching Mirrors compiler revision first; (3) start non-model waves and
hold Wave H. — Option 1 was selected on 2026-10-14.
