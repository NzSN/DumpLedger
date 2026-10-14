# Analyzer integration design

Status: milestones AI1–AI3 implemented (2026-10-13; model-interface
bindings regenerated against the current Mirrors compiler under the option-1
toolchain decision). AI4 remains deferred. Defines how an external, machine-driven analyzer consumes
DumpLedger as its dump catalog: discovery, change tracking, byte retrieval,
and analysis write-back. The analyzer stays a separate process and deployment;
DumpLedger remains catalog, vault, symbol store, and record of verdicts — it
never executes analysis itself.

## Purpose and scope

Four capabilities for one new consumer class:

- **Catalog search** — a first-class, filterable dump enumeration endpoint so
  the analyzer can find work without walking every case manifest.
- **Machine authentication** — a read-scoped bearer token so the analyzer
  never automates an operator's cookie session.
- **Event feed** — a pull-based, resumable cursor over the existing audit
  trail so the analyzer learns about new dumps and lifecycle changes without
  polling the whole catalog.
- **Analysis write-back** — an entity that stores analyzer verdicts against
  dumps, so results are queryable through the same catalog and survive
  analyzer restarts.

Non-goals for v1: running analysis inside DumpLedger, push delivery
(webhooks), per-customer analyzer scoping, analysis artifacts larger than a
JSON facts object (stack dumps, minidump-derived files stay on the analyzer's
own storage), and including analysis reports in transfer bundles.

## Vocabulary

Per CONTEXT.md discipline, new domain terms are fixed here:

**Analyzer**:
An external machine consumer that reads the catalog, downloads dump bytes and
symbols, runs its own tooling, and optionally reports verdicts back.
_Avoid_: worker, plugin

**Analyzer token**:
A configured bearer credential that authenticates an analyzer on read routes
(and, when analysis write-back is enabled, on the write-back route). Digest at
rest, like the CI symbol-ingest token.
_Avoid_: API key, service account

**Analysis report**:
One immutable verdict record attached to a dump, produced by one named
analyzer at one version against one dump content hash. Re-running the same
analyzer version against the same bytes is a no-op.
_Avoid_: verdict blob, scan result

**Event feed**:
The read-only, cursor-paginated HTTP surface over the ledger's audit events.
_Avoid_: webhook, notification queue

## Current surface and gaps

What an analyzer can already do (see http-api.md for the full inventory):

- list and search cases (`GET /api/v1/cases`) and read per-case manifests
  embedding that case's dumps and audit events;
- read dump detail (`GET /api/v1/dumps/:dumpId`) including `phase`,
  `sha256`, `validation`, and per-module `symbolCoverage`;
- stream dump bytes (`GET /api/v1/dumps/:dumpId/content`) under an audited
  `AuthorizeDownload` command;
- resolve symbols through the public symsrv surface
  (`GET /symbols/:name/:id/:file`), which CDB consumes directly.

Gaps, in the order an analyzer hits them:

1. **No catalog enumeration.** No route lists dumps across cases. The only
   path is list-cases → fetch every case manifest → filter client-side, and
   the manifest carries grants and audit history the analyzer does not need.
2. **No machine read credential.** All catalog reads require an operator
   session cookie; the only bearer tokens today are write-side (CI symbol
   ingest, upload grants).
3. **No change tracking.** Intake is recorded in `audit_events`
   (`BeginUpload`, `SealUpload`, `RejectDump`, `AuthorizeDownload`,
   `BeginPurge`, `FinishPurge`, `SealSymbol`, `PurgeSymbol`, transfer
   `BeginImport`/`FinishImport`, and lifecycle actions), but no HTTP route
   reads that stream, so the analyzer must re-poll the catalog.
4. **No verdict storage.** Analysis outcomes have no entity, so each analyzer
   keeps parallel private state and results cannot be queried or deduplicated
   through the catalog.
5. **No cheap revalidation.** Dump bytes are immutable once `available`, but
   nothing lets a holder of those bytes confirm currency without
   re-downloading.

## Dump catalog search

`GET /api/v1/dumps` is a read-only application query, like case search: no
engine command, no model change. Both session and analyzer-token callers may
use it (Authentication below).

### Query parameters

All parameters optional; each may appear at most once; unknown parameters are
rejected like every other shared decoder.

| Parameter | Match | Bound |
|---|---|---|
| `caseId`, `customerId` | exact ID | identifier shape |
| `phase` | exact dump-lifecycle phase | per `vocab.ts` |
| `validation` | exact validation state | per `vocab.ts` |
| `receivedAfter`, `receivedBefore` | `receivedAt` range, inclusive | canonical UTC ISO |
| `architecture` | exact inspector architecture string | ≤ 64 chars |
| `exceptionCode` | exact unsigned 32-bit code | JSON number range |
| `sha256` | exact content hash | 64 lowercase hex |
| `cursor` | pagination | ≤ 256 non-whitespace chars |

### Response rows

```text
{ "dumps": [DumpCatalogEntry…], "nextCursor?: string }
```

```text
DumpCatalogEntry = {
  dumpId, caseId, customerId,
  phase, validation,
  originalName,
  byteSize: string | null,          // decimal string, per wire convention
  sha256: string | null,            // lowercase hex; null until sealed
  receivedAt, availableAt: string | null, purgeAt: string | null,
  architecture?: string,            // inspector facts, when present
  exceptionCode?: number,           // uint32 as JSON number
  exceptionAddress?: string,        // uint64 as decimal string
  symbolCoverage: { present: number, missing: number, unidentified: number }
}
```

The coverage counts let the analyzer pre-flight symbolication (skip or
escalate dumps whose application modules are `missing`) without fetching
per-dump detail; the full `symbolCoverage` rows stay on the dump detail
route. Inspector facts are read from the stored `inspectionFacts`; a dump
whose inspection failed (`inspectionError` set) simply omits them.

### Ordering and pagination

Keyset pagination ordered by `(receivedAt, dumpId)` ascending — the intake
order an analyzer wants — with the cursor an opaque string encoding the last
seen pair. Unlike the offset cursor of case search, a keyset cursor stays
correct when intake interleaves with deep pagination, which is the normal
analyzer pattern. Page size caps at 200 entries, matching the existing list
conventions; an absent `nextCursor` is the end, and pagination does not pin
a snapshot across requests.

Backed by SQLite (`ORDER BY received_at, dump_id` with a covering index),
not by an in-memory projection scan: the catalog is the largest collection
in the ledger and this route exists for exhaustive traversal.

## Analyzer tokens

Mirrors the CI symbol-ingest token precedent (security-model.md, "CI
symbol-ingest tokens") exactly, with a read scope instead of an ingest scope.

- **Disabled by default.** Token auth exists only while
  `DUMP_LEDGER_ANALYZER_TOKEN_HASH` carries the 64-lowercase-hex sha256 of
  the bearer token. Unset or empty disables the path entirely.
- **Catalog-read scope.** The token is consulted by exactly the read routes:
  `GET /api/v1/dumps`, `GET /api/v1/dumps/:dumpId`,
  `GET /api/v1/dumps/:dumpId/content`, `GET /api/v1/cases`,
  `GET /api/v1/cases/:caseId`, `GET /api/v1/cases/:caseId/manifest`,
  `GET /api/v1/events` (below), and `GET /api/v1/symbols`. When milestone AI3
  lands, `POST /api/v1/dumps/:dumpId/analyses` is added to its scope. Every
  other route — all mutations, transfers, grants, purge — rejects the token
  with the same generic 401 as an anonymous request.
- **Pinned precedence.** On analyzer-scoped routes, any `Authorization`
  header selects only the bearer path: wrong token, malformed header, or
  disabled configuration is the generic 401 envelope, never a silent
  cookie/CSRF fallback. Without the header, the session guard applies
  unchanged.
- **No cookie semantics.** Bearer requests skip CSRF and Origin checks; they
  carry no ambient browser authority. TLS deployment and keeping the token
  out of URLs and logs are deployment obligations, unchanged from the ingest
  token.
- **Digest at rest, rotation by restart.** Only the sha256 digest is
  configured; the token itself has ≥ 256 bits of entropy and lives in the
  analyzer's secret store. Rotation is replace-hash-and-restart; no stateful
  revocation list.
- **Attribution.** Read routes record the auth channel in audit detail where
  one exists — `AuthorizeDownload` gains `downloadAuth: "analyzer-token"` vs
  `"operator"`, mirroring the symbol seal event's `ingestAuth`. Pure reads
  without an audit event today (catalog search, detail) stay unaudited in
  v1; the event feed is for intake truth, not access logging.

http-api.md's authentication table gains one label when implemented:
`Analyzer` = `Authorization: Bearer <token>` verified against the configured
analyzer digest; session callers retain access to the same routes.

## Event feed

`GET /api/v1/events` is a read-only cursor over `audit_events`, ordered by
SQLite `rowid` — append-only and strictly monotonic, so the cursor is the
zero-padded rowid of the last delivered row: cheap, stable, and honest about
being a ledger offset.

```text
GET /api/v1/events?since=<cursor>&actions=SealUpload,RejectDump&caseId=<id>&limit=<n>
```

- `since` — opaque cursor; absent means "from the beginning". A cursor
  beyond the current end returns an empty page with `nextCursor` equal to
  the request cursor, which is how a poller sleeps.
- `actions` — comma-separated filter over the audit action vocabulary;
  absent means all actions.
- `caseId` — optional exact case filter.
- `limit` — page size, default and maximum 500.

```text
{ "events": [Event…], "nextCursor": string }     // always present
```

```text
Event = {
  cursor: string,                  // zero-padded rowid; pass back as ?since=
  eventId, occurredAt, action,
  customerId: string | null, caseId: string | null, dumpId: string | null,
  detail: { … }                    // bounded, see below
}
```

**Payload sensitivity.** Security-model.md already constrains audit details
to "identifiers and outcomes, not dump contents or secret tokens"; the feed
relies on that invariant and enforces it mechanically — the response decoder
bounds `detail` to 4 KiB serialized per event, and a schema review of detail
payloads is a release gate for this milestone, not an afterthought.

**Why pull, not push.** The analyzer is LAN-resident with the instance; a
resumable cursor over the existing audit table adds no subscription storage,
no delivery retries, no signing secrets, and no ordering questions. Webhooks
are reconsidered only if a off-LAN consumer appears (Open questions).

Long-polling (`?wait=<ms>`) is explicitly deferred; a 5–30 s poll cadence is
adequate for crash-triage latency.

## Analysis write-back

The one capability that changes the engine, and therefore its own milestone
(AI3).

### Entity

**Analysis report** (vocabulary above): immutable once recorded, owned by
exactly one dump, deleted with that dump's purge. Identity:

```text
(dumpId, analyzer.name, analyzer.version, kind, inputSha256)
```

A repeat `POST` with an identity that already exists returns `200` with the
stored report — idempotent reprocessing is the normal analyzer retry path,
not an error.

### Wire shape

```text
POST /api/v1/dumps/:dumpId/analyses        -> 201 AnalysisReport (200 on replay)
GET  /api/v1/dumps/:dumpId/analyses        -> 200 { analyses: AnalysisReport[] }
```

```text
AnalysisReport = {
  analysisId, dumpId,
  analyzer: { name: string, version: string },   // self-reported, untrusted
  kind: string,                    // 1–64 chars, e.g. "triage" | "symbolication" | "classification"
  inputSha256: string,             // must equal the dump's current sha256
  createdAt,                       // server clock, never the analyzer's
  outcome: "completed" | "failed",
  summary: string,                 // ≤ 2000 chars
  facts?: { … },                   // bounded JSON, ≤ 16 KiB with the rest of the body
  duplicateOf?: dumpId | null
}
```

`kind` is a bounded string, not a contract enum: new analyzer kinds must not
require a contract release. `inputSha256` pins the verdict to exact bytes; a
mismatch with the dump's sealed hash is `invalid_request`, so a verdict can
never silently attach to different bytes. `createdAt` follows the retention
route's rule: the server clock is authoritative.

### Engine, ledger, and model impact

- New engine command `RecordAnalysis`, validated and audited (action
  `RecordAnalysis`, so reports appear on the event feed for free) inside one
  ledger transaction; dump must exist and be in a stable phase.
- New SQLite table `dump_analyses` with a unique index over the identity
  tuple; cascade on dump purge; schema migration per the existing migration
  discipline.
- New ID prefix `analysis_`; new contract module
  `packages/http-contracts/src/analyses.ts` with decode/encode symmetric
  pairs per the existing convention.
- The TLA+ spec gains a `RecordAnalysis` action in the same milestone; MBT
  trace regeneration is an explicit maintainer action (AGENTS.md), listed
  separately in the milestone PR.
- **Transfer exclusion (decision).** Export bundles do not carry analysis
  reports in v1: they are analyzer-regenerable, and bundle format stability
  (import-export-design.md) is more valuable. The manifest gains a
  `skippedAnalyses` count so the omission is visible, and re-derivation is a
  documented analyzer operation, not an operator burden.

## Conditional requests and dedup aids

- **ETag on content.** `GET /api/v1/dumps/:dumpId/content` returns a strong
  `ETag: "<sha256>"` once the dump is `available`, downloadable, and has a
  sealed sha256 (as implemented); `If-None-Match` short-
  circuits to `304`. `Cache-Control: no-store` is unchanged — this is
  validator semantics for clients that deliberately hold bytes (the
  analyzer's own cache), not permission for intermediary caching.
- **Hash lookup.** `GET /api/v1/dumps/by-sha256/:sha256` returns the catalog
  entries with that content hash (normally zero or one), backed by an index
  on `dumps.sha256`. This is the analyzer's and any upstream producer's
  duplicate check, cheaper than a filtered catalog scan.

## Contracts, limits, and errors

- All new shapes live in `packages/http-contracts/src/` with symmetric
  decoders/encoders; unknown fields, duplicate keys, and wrong types are
  rejected like everywhere else; JSON bodies keep the 16 KiB limit.
- Page caps: 200 dumps per catalog page, 500 events per feed page; list
  response decoders bound arrays at 4096 like the existing detail responses.
- No new stable error codes: malformed filters and cursors are
  `invalid_request`; unknown IDs are `not_found`; bearer failures are the
  generic `unauthenticated` envelope.
- Every new route serves `Cache-Control: no-store` and the standard content
  types; byte counts stay decimal strings, timestamps canonical UTC ISO,
  hashes lowercase hex.

## Security considerations

- The analyzer token is bearer-equivalent and read-mostly: its worst case is
  disclosure of catalog metadata and dump bytes, never mutation (pre-AI3) or
  ledger administration (ever). It must still ride TLS and never appear in
  URLs or logs.
- The event feed publishes operational metadata (intake cadence, download
  timing) to token holders; acceptable on the private-interface deployment
  the security model assumes, and the token is the gate.
- Analyzer-supplied `analyzer.name`/`version` are attribution hints, not
  identity: distinct analyzer deployments with distinct trust requirements
  need distinct configured digests, which v1 does not support (Open
  questions).
- Analysis `facts` are stored, later-rendered JSON: the same untrusted-input
  discipline as dump `originalName` applies — bounded size at decode, and the
  web UI renders them as text, never markup.

## Test and model strategy

- Unit: contract decoders for every new shape, including bounds and
  duplicate-field rejection.
- Integration: catalog filter matrix, keyset pagination under concurrent
  intake, token precedence (wrong token + valid cookie is 401), event-feed
  cursor edge cases (empty, beyond-end, filtered), ETag 304, write-back
  idempotent replay and sha mismatch.
- MBT: the AI3 spec action gets harness bindings; catalog/events/token work
  is read-surface and covered by integration tiers, with the model-interface
  check (`pnpm run check:model-interface`) gating as usual.
- Documentation obligations per milestone: http-api.md inventory and
  authentication table, security-model.md token section, CONTEXT.md if any
  term's meaning shifts.

## Phasing

| Milestone | Content | Engine/model impact |
|---|---|---|
| AI1 | `GET /api/v1/dumps`, by-sha256 lookup, content ETag, analyzer token (read scope) | none — application query, auth guard, index migrations |
| AI2 | `GET /api/v1/events` | none — read surface over `audit_events` |
| AI3 | Analysis write-back (`POST`/`GET …/analyses`), feed attribution | engine command, table migration, TLA+ action, MBT traces |
| AI4 (optional) | Query-scoped export bundles for bulk pull; long-poll or webhooks if pull proves insufficient | transfer filter parameters |

AI1 alone makes DumpLedger minimally usable as the analyzer's source;
AI1+AI2 make it comfortable (discover once, then follow the feed); AI3
closes the loop so verdicts live next to the evidence they describe.

## Open questions

1. **Case manifest on the token.** Resolved in v1 (2026-10-13): the manifest
   is NOT in token scope — the analyzer works from the catalog, dump detail,
   and the event feed. Reopen only if a real consumer needs case navigation.
   Also unimplemented as of AI3: the `downloadAuth` audit-attribution detail
   on `AuthorizeDownload` (the "Attribution" bullet above) — tracked as a
   candidate follow-up.
2. **Multiple analyzers.** One configured digest means one token shared by
   all analyzers, with self-reported `analyzer.name` as the only attribution.
   Per-analyzer digests (a small configured map) are the upgrade path if
   blame or revocation granularity ever matters.
3. **Push delivery.** A off-LAN or latency-critical consumer would motivate
   signed webhooks; none is known today, and the feed keeps that door open
   without paying for it now.
