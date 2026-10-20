# Webhook notifications design

Status: shipped as milestone WH1 (2026-10-20, commit e604ba0). Resolves the AI4 open question in
[`analyzer-integration-design.md`](analyzer-integration-design.md) ("long-poll
or webhooks if pull proves insufficient") for the concrete case of an external
analyzer that should react to a new dump without polling.

## Goal and non-goals

**Goal.** When intake truth changes — above all `AcceptDump`, "a new dump is
uploaded and available" — DumpLedger pushes a signed HTTP notification to
operator-registered endpoints, at LAN latency, without the consumer polling
`GET /api/v1/events`.

**Non-goals (v1).**

- Guaranteed delivery. Webhooks are a low-latency **tap**; the audit event
  feed remains the resumable **truth**. A consumer that must not miss events
  still reconciles against the feed.
- Off-LAN fan-out, payload transforms, per-consumer authentication schemes.
- Audit-trail entries for webhook administration. Subscription CRUD is
  operational configuration, not ledger domain state: it issues no engine
  command, no TLA+ action, and no audit event (same boundary as the AI1
  catalog reads). Modeling it is a future spec change, not this milestone.
- Push-driven wakeups inside intake (the dispatcher is tick-driven).

## Architecture: tap, not truth

The dispatcher is an **in-process follower of the audit feed**. It reads
`audit_events` through the engine's existing `readAuditEvents` keyset read —
read-only, no engine command, no projection change, exactly the AI1/AI2
precedent — and POSTs matching events to subscribed URLs. Each subscription
carries a durable cursor (`cursor_rowid`), so restarts resume where delivery
stopped.

```
intake ──► engine ──► audit_events (truth)
                         ▲                    │
                         │ readAuditEvents    │ feed pollers (AI2)
                         │                    ▼
                   WebhookDispatcher ──► POST https://analyzer/... (tap)
                         │
                         ▼
            webhook_subscriptions, webhook_deliveries (migration 11)
```

Because the tap shares the feed's source, its event shape, filters, and
ordering are identical to what a poller sees; the two channels cannot
disagree about content, only about latency.

## Storage (migration 11)

Operational state, additive-only, owned by the same single-writer SQLite
connection as the ledger (a `SqliteWebhookStorage` constructed inside
`SqliteLedger`, surfaced read-through on the engine as `webhookStorage()`):

```sql
CREATE TABLE webhook_subscriptions (
  subscription_id TEXT PRIMARY KEY,
  url TEXT NOT NULL CHECK (length(url) BETWEEN 1 AND 2048),
  secret TEXT NOT NULL,
  actions_json TEXT,                              -- NULL = all actions
  case_id TEXT REFERENCES cases(case_id),         -- NULL = all cases
  cursor_rowid INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
) STRICT;
CREATE TABLE webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL REFERENCES webhook_subscriptions(subscription_id) ON DELETE CASCADE,
  event_rowid INTEGER NOT NULL,
  action TEXT NOT NULL,
  dump_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'exhausted')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_status_code INTEGER,
  last_error TEXT,
  next_attempt_at TEXT,
  delivered_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (subscription_id, event_rowid)
) STRICT;
CREATE INDEX webhook_deliveries_recent_idx ON webhook_deliveries(subscription_id, created_at);
```

- `secret` is the per-subscription HMAC signing secret, stored plaintext in
  `ledger.sqlite` (see "Secrets at rest" below) and shown once at creation.
- A new subscription's `cursor_rowid` starts at the **live edge** (`MAX(rowid)`
  of `audit_events` at creation): subscriptions deliver from creation forward;
  history is what the feed is for.
- The `UNIQUE (subscription_id, event_rowid)` pair makes retries idempotent:
  a retry re-attempts the existing delivery row instead of duplicating it.

## Delivery semantics

Per subscription, **ordered, at-least-once, head-of-line blocking**:

1. Each tick, for each subscription in creation order, the dispatcher reads
   one feed page after `cursor_rowid` with the subscription's `actions` /
   `caseId` filter applied.
2. Events are delivered strictly in `rowid` order. A failure stops the page
   for that subscription; the cursor does not advance past the failed event,
   so the next attempt retries exactly that event.
3. Retry with exponential backoff `base * 5^(attempts-1)` (default base 10 s:
   10 s, 50 s, ~4 m, ~21 m), recorded as `next_attempt_at`; the dispatcher
   skips a pending delivery until it is due.
4. After `maxAttempts` failures (default 5) the delivery is marked
   `exhausted` — with `last_status_code` / `last_error` — and the cursor
   advances past it. **Exhaustion is visible, not silent**: the event remains
   in the feed, and the delivery row is the ops record. Guaranteeing
   no-event-lost is the feed's job, by design.
5. Success is any 2xx. Everything else — non-2xx, connect failure, timeout —
   is a retryable failure.

The dispatcher is concurrency-1 (sequential ticks, no overlap), mirroring
`PostProcessingQueue`'s injectable scheduler so tests drive time explicitly.

## Wire format

`POST <subscription url>`, `Content-Type: application/json`, body is exactly
the feed `Event` object — a consumer already speaking AI2 needs no new
parser:

```json
{ "cursor": "0000000000000674", "eventId": "…", "occurredAt": "…",
  "action": "AcceptDump", "customerId": "…", "caseId": "…", "dumpId": "…",
  "detail": { } }
```

Headers:

- `X-DumpLedger-Event: AcceptDump` — the audit action.
- `X-DumpLedger-Delivery: whd_…` — unique delivery id; with `cursor` this is
  the receiver's dedupe key (at-least-once means redelivery is normal).
- `X-DumpLedger-Delivered-At: <ISO timestamp>`.
- `X-DumpLedger-Signature-256: sha256=<hex>` — HMAC-SHA256 of the **raw
  request body** keyed by the subscription secret (GitHub convention, so
  receivers can reuse stock verification snippets).
- `User-Agent: DumpLedger-Webhook/1`.

Receiver verification is three lines: read raw body, `HMAC_SHA256(secret,
body)`, constant-time compare against the header.

## Management API (operator session only)

**Superseded by WH2** ([webhook-admin-token-design.md](webhook-admin-token-design.md)):
the four routes are dual-auth — operator session or webhook-admin bearer
token. The session-only text below is the WH1 historical record.

All four routes require the operator session cookie (`jsonRequireSession`);
mutations additionally pass the mutation guard (`jsonRequireMutation`). The
analyzer bearer token is **not** accepted: a subscription pushes event data
to an arbitrary URL, so registering one is an operator privilege.

| Route | Purpose |
|---|---|
| `POST /api/v1/webhooks` | Create `{ url, actions?, caseId? }` → `201 { subscription, secret }`; the secret is returned **only here** |
| `GET /api/v1/webhooks` | List subscriptions (id, url, actions, caseId, cursor, createdAt) — never the secret |
| `DELETE /api/v1/webhooks/:webhookId` | Remove (deliveries cascade) → `204` |
| `GET /api/v1/webhooks/:webhookId/deliveries` | Latest 50 delivery rows, most recent first — the ops view of retries and exhaustions |

URL validation: must parse as `http:` or `https:`, no userinfo, ≤ 2048
chars. `actions` follows the feed filter bounds (≤ 32 entries, ≤ 64 chars
each). A `caseId` must name an existing case or creation fails
`invalid_request`.

## Security considerations

- **SSRF control is the operator gate.** Only an authenticated operator can
  register a URL, and the documented deployment is LAN-resident — posting to
  private addresses (the analyzer) is the point, so no network-range filter
  is applied. This tradeoff is recorded in `security-model.md`.
- **Secrets at rest.** Signing secrets live in `ledger.sqlite`, which the
  deployment model already protects as instance-private (data dir mode
  0700). They are never returned by list/get routes and never written to the
  audit trail or delivery rows.
- **Payload sensitivity** inherits the feed invariant: event `detail`
  carries identifiers and outcomes, never dump bytes or tokens.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DUMP_LEDGER_WEBHOOKS` | unset (off) | `on` starts the dispatcher; subscriptions accumulate pending deliveries while off |
| `DUMP_LEDGER_WEBHOOK_TICK_MS` | `2000` | Dispatcher poll interval |
| `DUMP_LEDGER_WEBHOOK_TIMEOUT_MS` | `10000` | Per-attempt HTTP timeout |
| `DUMP_LEDGER_WEBHOOK_RETRY_BASE_MS` | `10000` | Backoff base (×5 per attempt) |
| `DUMP_LEDGER_WEBHOOK_MAX_ATTEMPTS` | `5` | Attempts before exhaustion |

## Testing strategy

- **Unit**: storage against `:memory:` SQLite (CRUD, cursor, delivery state
  transitions, idempotent retry upsert); dispatcher with injected storage /
  event source / fetch / scheduler (ordering, backoff dues, exhaustion,
  timeout, non-2xx, cursor rules); contracts decoders (bounds, unknown keys).
- **Integration**: management routes through the real Fastify stack (auth
  precedence, validation, secret-once); end-to-end delivery with a real
  engine driven by commands and a real loopback HTTP receiver asserting one
  signed `AcceptDump` POST.
- **Out of scope**: TLA+/MBT — no engine action changes, so
  `check:model-interface` is unaffected; this is stated as a boundary, not
  silently skipped.

## Milestones

- **WH1** (this design): storage, dispatcher, management API, docs.
- **WH2** (shipped, separate design): the webhook-admin token lets a machine
  caller (DumpAnalyzer) manage subscriptions without an operator session —
  see [webhook-admin-token-design.md](webhook-admin-token-design.md).
- **WH3 candidates** (only when a consumer asks): wake-on-intake channel,
  disable-after-N-exhaustions, delivery metrics, audit events for
  subscription administration (a TLA+ change).
