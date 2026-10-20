# Analyzer integration guide

How to build an external analyzer against a DumpLedger instance: discover
dumps, follow new intake, retrieve bytes, resolve symbols, and write verdicts
back. DumpLedger is the catalog, vault, symbol store, and record of verdicts;
your analyzer is a separate process and never runs inside it.

This is the task-oriented guide. [http-api.md](http-api.md) is the full wire
reference; [analyzer-integration-design.md](analyzer-integration-design.md)
records the design rationale; [security-model.md](security-model.md) covers
the token's threat model. Vocabulary follows [CONTEXT.md](../CONTEXT.md)
(Case, dump lifecycle, upload grant, analysis report).

## Prerequisites

- **Base URL.** The operator's HTTPS origin, e.g. `https://<host>:4080`.
  Self-hosted deployments typically use a self-signed certificate — pin it or
  configure your HTTP client to trust it deliberately; do not disable
  verification blindly.
- **An analyzer token.** The operator generates a token with at least 256
  bits of entropy and configures only its sha256 on the server:

  ```bash
  token=$(openssl rand -hex 32)                 # the secret you keep
  printf '%s' "$token" | sha256sum              # the hex digest the operator configures
  ```

  The operator sets `DUMP_LEDGER_ANALYZER_TOKEN_HASH=<digest>` and restarts.
  Unset means the bearer path is disabled and every analyzer request is a
  generic 401. Keep the token in your secret store; never in URLs or logs.

## Authentication

Send `Authorization: Bearer <token>` on every request. No cookies, no CSRF
token, no `Origin` header.

The precedence rule is pinned: if a request carries **any** `Authorization`
header, only the bearer path is consulted — a wrong or malformed token is a
401 even alongside a valid operator session cookie. Failed bearer auth never
falls through to session behavior.

Token scope is exactly: the catalog reads, dump detail and content, the
event feed, the customer list (`GET /api/v1/customers`, for resolving a
customer's display name to its id), and analysis write-back (the table in
http-api.md is the authoritative list). Everything else — case workflow, grants, retention,
symbols ingest, transfers — rejects the token.

## The integration loop

### 1. Initial sync — the dump catalog

```
GET /api/v1/dumps?phase=available&cursor=<opaque>
```

Page through `GET /api/v1/dumps` (200 rows per page) to build your initial
worklist. Filters: `caseId`, `customerId`, `phase`, `validation`,
`receivedAfter`, `receivedBefore`, `architecture`, `exceptionCode`, `sha256`.
Each row carries identity, lifecycle, `sha256` (when sealed), byte size
(decimal string), inspector facts when available, and `symbolCoverage`
counts — enough to prioritize without per-dump detail calls.

Cursor rules: follow `nextCursor` with the **same** filters; an absent
`nextCursor` is the end; pagination does not pin a snapshot, so dumps
arriving mid-scan appear on a later page.

Duplicate check before uploading-or-reprocessing elsewhere:
`GET /api/v1/dumps/by-sha256/:sha256`.

### 2. Follow changes — the audit event feed

```
GET /api/v1/events?since=<cursor>&actions=AcceptDump,RejectDump&limit=500
```

After the initial sync, poll the feed instead of rescanning the catalog.
The cursor is the zero-padded rowid of the last event you consumed;
`nextCursor` is **always** present, so a beyond-end page just echoes your
position — sleep and retry. A 5–30 s cadence is adequate for triage work.

Dump-relevant actions (see http-api.md for the full vocabulary):

| Action | Meaning for the analyzer |
|---|---|
| `AcceptDump` | Dump passed inspection and is `available` — bytes retrievable |
| `RejectDump` | Dump failed validation; `detail` carries the reason |
| `BeginPurge` / `FinishPurge` | Retention started / bytes gone (analyses cascade-deleted) |
| `SealSymbol` / `PurgeSymbol` | Symbol store gained / lost an artifact |
| `RecordAnalysis` | Another analyzer (or you, via a second deployment) recorded a report |

Event `detail` is bounded to 4 KiB and contains identifiers and outcomes,
never dump contents or secrets.

#### Push alternative — webhooks (WH1; self-registration WH2)

If the instance runs with `DUMP_LEDGER_WEBHOOKS=on`, you can skip polling.
Ask the operator for a **webhook-admin token** — a dedicated bearer
credential scoped to exactly the four `/api/v1/webhooks` routes
([webhook-admin-token-design.md](webhook-admin-token-design.md)); your
analyzer token is rejected there by design. At boot, send it as
`Authorization: Bearer <webhook-admin token>` and self-register: list your
subscriptions with `GET /api/v1/webhooks` first and keep an existing one for
your URL (idempotent across restarts), otherwise create one:

```
POST /api/v1/webhooks { "url": "http://<your-host>/webhooks",
                        "actions": ["AcceptDump", "RejectDump"] }
```

Persist the `secret` from the `201` response in your own secret store — it is
returned only once. DumpLedger then POSTs each matching event — the exact
same `Event` object the feed serves — to your URL, signed with that
subscription secret:

```
X-DumpLedger-Signature-256: sha256=<HMAC-SHA256(secret, raw body)>
X-DumpLedger-Event: AcceptDump        X-DumpLedger-Delivery: whd_...
```

Verify the signature over the **raw** body before parsing, dedupe on the
delivery id / `cursor`, and answer 2xx. Delivery is ordered and
at-least-once with backoff (10 s → ~21 min); after five failed attempts the
event is marked `exhausted` and skipped — so keep the feed as your
reconciliation path for anything you cannot afford to miss. Full semantics and the step-by-step registration walkthrough:
[webhook-notifications.md](webhook-notifications.md#registering-a-webhook-step-by-step).

To decommission, `DELETE /api/v1/webhooks/<id>` for your subscriptions and
then ask the operator to rotate the webhook-admin token: rotation alone does
not stop an existing subscription.

### 3. Retrieve bytes

```
GET /api/v1/dumps/:dumpId/content
ETag: "<sha256>"
```

Only `available` dumps serve bytes. The response carries a strong
`ETag` equal to the content sha256; send `If-None-Match` on refetches and
expect `304` while nothing changed. Dump bytes are immutable — cache them
locally keyed by sha256. After `FinishPurge`, content is gone for good;
your own storage is responsible for anything you need beyond retention.

`GET /api/v1/dumps/:dumpId` (detail) adds validation state, inspection
errors, and the full per-module `symbolCoverage` list.

### 4. Symbols

The debugger-facing symsrv surface needs no token at all:

```
.sympath SRV*C:\symcache*https://<host>:4080/symbols
```

(or `http://<host>:4082/symbols` on the loopback-only deployment). CDB /
WinDbg resolve application PDBs straight from DumpLedger; the HTTP store
must be last in the sympath. Use a dump's `symbolCoverage` to pre-flight:
modules marked `missing` will not resolve — either ingest the matching
build's symbols first (operator action) or analyze without them.

### 5. Write back analysis reports

```
POST /api/v1/dumps/:dumpId/analyses
Content-Type: application/json
Authorization: Bearer <token>

{ "analyzer": { "name": "cdb-triage", "version": "1.4.2" },
  "kind": "triage",
  "inputSha256": "<the dump's sha256>",
  "outcome": "completed",
  "summary": "Access violation in GeometryMapper::Unmap; matches case 41 pattern",
  "facts": { "exceptionCode": "0xc0000005", "faultingModule": "content.dll" },
  "duplicateOf": null }
```

- **Pin to bytes.** `inputSha256` must equal the dump's sealed sha256; a
  mismatch is `invalid_request`. A verdict can never silently attach to
  different bytes.
- **Idempotent replay.** The identity tuple `(dumpId, analyzer.name,
  analyzer.version, kind, inputSha256)` is unique. Re-posting it returns
  `200` with the stored report — safe retries and restarts are the intended
  pattern. A fresh tuple returns `201`. Bump `analyzer.version` when your
  logic changes; do not reuse a version for different behavior.
- **Kinds** are self-described (`triage`, `symbolication`,
  `classification`, …) — a bounded string, not a registry.
- **Bounds**: `summary` ≤ 2000 chars, `facts` ≤ 4 KiB JSON, body within the
  16 KiB JSON limit, at most 64 distinct reports per dump (the 65th is
  `409 invalid_transition`; replays never count).
- Reports are immutable, deleted with the dump's purge, and **not** carried
  in export bundles (the manifest's `skippedAnalyses` count records the
  omission) — they are regenerable by re-running you.

Every recorded report emits a `RecordAnalysis` audit event, so other
consumers can follow write-back through the same feed.

## Vocabulary cheat sheet

Dump phases: `receiving` → `sealed` → `quarantined` → `available` |
`rejected`; `deleting` → `deleted` under retention. Validation:
`not-checked` | `valid` | `invalid` | `transfer-failed`. Only `available`
dumps have downloadable bytes. Case workflow (`new` … `closed`) is
independent of the dump lifecycle; filter on `phase`, not case status.

## Errors and retries

All errors share one envelope: `{ code, message, retryable }`.

| Status | Code | What to do |
|---|---|---|
| 400 | `invalid_request` | Malformed filter/cursor/body — fix the request; not retryable |
| 401 | `unauthenticated` | Token wrong/disabled/absent — check with the operator |
| 404 | `not_found` | Unknown dump id (or purged content) — drop from your worklist |
| 409 | `invalid_transition` | Dump not `available` (or the 64-report cap) — re-check phase via the feed |

Reads are idempotent; safe to retry freely after network errors. Writes are
idempotent by identity tuple; safe to retry after any outcome.

## Conventions recap

Byte counts and 64-bit values are decimal strings on the wire; timestamps
are canonical UTC ISO; sha256 is lowercase hex; IDs are opaque
server-issued strings — never infer one from a filename. JSON responses are
`no-store`; intermediate caching is your own choice outside the protocol.
TypeScript analyzers co-located with this repo may import the runtime
decoders from `packages/http-contracts` (`catalog`, `events`, `analyses`
modules) instead of hand-rolling shapes.

## Minimal end-to-end example

```bash
BASE="https://127.0.0.1:4080"; TOKEN="<your token>"; AUTH="Authorization: Bearer $TOKEN"

# Initial sync: newest-available page
curl -sk -H "$AUTH" "$BASE/api/v1/dumps?phase=available" | jq '{n: (.dumps|length), next: .nextCursor}'

# Follow the feed (cursor "0" = from the beginning)
cursor=0
while true; do
  page=$(curl -sk -H "$AUTH" "$BASE/api/v1/events?since=$cursor&actions=AcceptDump&limit=500")
  echo "$page" | jq -c '.events[] | {cursor, dumpId, occurredAt}'
  cursor=$(echo "$page" | jq -r '.nextCursor')
  sleep 10
done

# Retrieve bytes for one dump, with revalidation
etag=$(curl -sk -D - -o /dev/null -H "$AUTH" "$BASE/api/v1/dumps/dump_<id>/content" | grep -i '^etag:' | cut -d'"' -f2)
curl -sk -H "$AUTH" -H "If-None-Match: \"$etag\"" -o dump.dmp -w '%{http_code}\n' \
  "$BASE/api/v1/dumps/dump_<id>/content"        # 304 -> your cached copy is current

# Write back a verdict (idempotent)
curl -sk -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"analyzer":{"name":"cdb-triage","version":"1.4.2"},"kind":"triage",
       "inputSha256":"<sha256>","outcome":"completed","summary":"..."}' \
  "$BASE/api/v1/dumps/dump_<id>/analyses"
```
