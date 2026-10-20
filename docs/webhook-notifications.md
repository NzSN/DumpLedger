# Webhook notifications

Status: shipped as milestone WH1 (2026-10-20). Rationale and rejected
alternatives live in [webhook-notifications-design.md](webhook-notifications-design.md);
this document describes the mechanism as implemented. Route shapes are
specified in [http-api.md](http-api.md#webhooks); threat-model treatment in
[security-model.md](security-model.md).

DumpLedger can notify an external consumer — above all an analyzer waiting
for newly uploaded dumps — by pushing signed HTTP POSTs to
operator-registered URLs, instead of the consumer polling
`GET /api/v1/events`.

## Tap, not truth

Webhooks are a low-latency **tap** on the audit event feed, which remains the
resumable **truth**. The in-process dispatcher reads `audit_events` through
the engine's `readAuditEvents` keyset read — read-only: no engine command,
no TLA+ action, no projection change — and POSTs matching events to
subscribed URLs. Both channels serve the same events in the same order with
the same payloads; they differ only in latency and delivery guarantees.

A consumer that must not miss events reconciles against the feed; a consumer
that only needs low latency can live on webhooks alone until a delivery row
shows `exhausted`.

```
intake ──► engine ──► audit_events (truth)
                         ▲                    │
                         │ readAuditEvents    │ feed pollers
                         │                    ▼
                   WebhookDispatcher ──► POST https://analyzer/... (tap)
                         │
                         ▼
            webhook_subscriptions, webhook_deliveries (migration 11)
```

## Delivery semantics

Per subscription: **ordered, at-least-once, head-of-line blocking**.

- The dispatcher ticks every `DUMP_LEDGER_WEBHOOK_TICK_MS` (default 2 s),
  reads one feed page after the subscription's durable `cursor_rowid` with
  the subscription's `actions`/`caseId` filter, and delivers strictly in
  feed order.
- A failed attempt stops that subscription's page (later events wait); other
  subscriptions proceed unaffected.
- Retries use exponential backoff `base × 5^(attempts−1)` — 10 s, 50 s,
  ~4 min, ~21 min at defaults — recorded as `next_attempt_at`.
- After `DUMP_LEDGER_WEBHOOK_MAX_ATTEMPTS` (default 5) the delivery is
  marked `exhausted` with the last status/error, and the cursor advances.
  Exhaustion is visible, not silent: the event stays in the feed and the
  delivery row is the ops record.
- Success is any 2xx. Non-2xx, connect failures, and timeouts
  (`DUMP_LEDGER_WEBHOOK_TIMEOUT_MS`, default 10 s) are retryable.
- A new subscription's cursor starts at the live edge: it receives events
  from creation forward; history is what the feed is for.

## Wire format

`POST <subscription url>` with `Content-Type: application/json`. The body is
exactly the feed `Event` object — a consumer already speaking the AI2 feed
needs no new parser:

```json
{ "cursor": "0000000000000674", "eventId": "…", "occurredAt": "…",
  "action": "AcceptDump", "customerId": "…", "caseId": "…", "dumpId": "…",
  "detail": { } }
```

Headers:

| Header | Meaning |
|---|---|
| `X-DumpLedger-Event` | Audit action, e.g. `AcceptDump` |
| `X-DumpLedger-Delivery` | Unique delivery id (`whd_…`); with `cursor`, the receiver's dedupe key |
| `X-DumpLedger-Delivered-At` | ISO timestamp of this attempt |
| `X-DumpLedger-Signature-256` | `sha256=<hex>` — HMAC-SHA256 of the raw body keyed by the subscription secret |
| `User-Agent` | `DumpLedger-Webhook/1` |

Receiver verification (Node.js; any HMAC-SHA256 works):

```js
const expected = "sha256=" +
  createHmac("sha256", secret).update(rawBody).digest("hex");
if (!timingSafeEqual(Buffer.from(expected), Buffer.from(header))) reject();
```

Verify over the **raw** body before parsing JSON. Redelivery is normal
(at-least-once): dedupe on `X-DumpLedger-Delivery` / `cursor`.

## Managing subscriptions

All four routes require the **operator session cookie** or the WH2
webhook-admin bearer token (below); the analyzer bearer token is not
accepted. Session mutations pass the Origin/Fetch-Metadata guard.

**WH2 authorization.** A machine caller presents
`Authorization: Bearer <token>` with the digest configured in
`DUMP_LEDGER_WEBHOOK_ADMIN_TOKEN_HASH` (see
[webhook-admin-token-design.md](webhook-admin-token-design.md)): no cookie and
no CSRF/Origin evidence, because a machine caller has no ambient browser
authority. An `Authorization` header selects the bearer path only — a wrong
or disabled token is `401` even alongside a valid session cookie. The
operator browser session is unchanged.

| Route | Purpose |
|---|---|
| `POST /api/v1/webhooks` | Create `{ url, actions?, caseId? }` → `201 { subscription, secret }`. The secret is returned **only here**. |
| `GET /api/v1/webhooks` | List subscriptions (never the secret). |
| `DELETE /api/v1/webhooks/:webhookId` | Remove; delivery rows cascade → `204`. |
| `GET /api/v1/webhooks/:webhookId/deliveries` | Latest 50 delivery rows, newest first — the ops view of retries and exhaustions. |

**Request.** `{ "url": "http://analyzer:4180/webhooks", "actions":
["AcceptDump"], "caseId": null }` — `url` must be `http:` or `https:`, no
userinfo, ≤ 2048 chars; `actions` (optional, absent = all audit events)
follows the feed filter bounds (≤ 32 entries, ≤ 64 chars each); `caseId`
(optional) must name an existing case.

**Response.** `201` with the subscription and its signing secret:

```json
{ "subscription": { "id": "whs_…", "url": "…", "actions": ["AcceptDump"],
                    "caseId": null, "cursor": "0000000000000712",
                    "createdAt": "2026-10-20T08:00:00.000Z" },
  "secret": "whsec_…" }
```

The `secret` is returned **only in this response** — store it in the
receiver's secret store immediately; it cannot be recovered (rotate by
deleting and recreating). The `cursor` starts at the feed's live edge: the
subscription delivers events from registration forward, never history.

## Registering a webhook, step by step

Both paths perform the same `POST /api/v1/webhooks`; they differ only in how
the caller authenticates. Examples use the default loopback origin —
deployments front the service with HTTPS (see README), so substitute the
operator's HTTPS origin in practice.

### Path A — machine caller (webhook-admin bearer token)

The path DumpAnalyzer and other automation use (WH2). One-time setup on the
server, then the caller needs no cookie and no CSRF token:

```sh
# 1. One-time, on the DumpLedger host: mint a credential.
npm run generate:webhook-admin-token
#   Webhook admin token (store in the caller's secret store, shown once): <token>
#   DUMP_LEDGER_WEBHOOK_ADMIN_TOKEN_HASH=<64 lowercase hex>

# 2. Configure the digest and restart the service.
export DUMP_LEDGER_WEBHOOK_ADMIN_TOKEN_HASH='<digest from step 1>'

# 3. Register — from any host that holds the token.
curl -X POST https://<host>:4080/api/v1/webhooks \
  -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{ "url": "http://analyzer:4180/webhooks", "actions": ["AcceptDump"] }'
```

Idempotent (re)registration at boot: list first, reuse what matches your own
URL, create only when absent:

```sh
curl -H 'Authorization: Bearer <token>' https://<host>:4080/api/v1/webhooks
# → { "subscriptions": [ … ] }   # keep the entry whose url is yours
```

Notes: never combine paths — any `Authorization` header selects the bearer
path exclusively, so a wrong token is `401` even with a valid session
cookie. The analyzer token (feed/catalog scope) is **rejected** on these
routes by design; only the webhook-admin token works here.

### Path B — operator browser session (curl)

The operator path: log in once, then send cookie + CSRF token.

```sh
# 1. Log in — sets dump_ledger_session in the jar and returns the CSRF token.
curl -c cookies.txt -X POST https://<host>:4080/api/v1/session \
  -H 'Content-Type: application/json' \
  -d '{ "password": "<operator password>" }'
# → { "authenticated": true, "csrfToken": "…", "expiresAt": "…" }

# 2. Register — cookie authenticates, X-CSRF-Token proves intent.
curl -b cookies.txt -X POST https://<host>:4080/api/v1/webhooks \
  -H 'Content-Type: application/json' \
  -H 'X-CSRF-Token: <csrfToken from step 1>' \
  -d '{ "url": "http://analyzer:4180/webhooks", "actions": ["AcceptDump"] }'
```

Sessions expire (eight hours by default); re-read a fresh token with
`GET /api/v1/session -b cookies.txt` instead of logging in again. Reads
(`GET /api/v1/webhooks`, `…/deliveries`) need only the cookie; mutations
(POST, DELETE) need the cookie **and** the CSRF header.

### After registration

Deliveries begin on the dispatcher's next tick (≤ 2 s by default). Verify
`X-DumpLedger-Signature-256` on every POST (see [Wire
format](#wire-format)), watch `GET
/api/v1/webhooks/:webhookId/deliveries` for retries or `exhausted` rows, and
`DELETE /api/v1/webhooks/:webhookId` to unregister (either credential).

Useful actions for consumers: `AcceptDump` (uploaded, validated, available —
the "new dump" signal), `RejectDump`, `SealUpload` (bytes arrived, not yet
inspected), `RecordAnalysis` (analyzer write-back landed). Absent `actions`
delivers every audit event.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DUMP_LEDGER_WEBHOOKS` | unset (off) | `on` starts the dispatcher; subscriptions accumulate pending deliveries while off |
| `DUMP_LEDGER_WEBHOOK_TICK_MS` | `2000` | Dispatcher poll interval |
| `DUMP_LEDGER_WEBHOOK_TIMEOUT_MS` | `10000` | Per-attempt HTTP timeout |
| `DUMP_LEDGER_WEBHOOK_RETRY_BASE_MS` | `10000` | Backoff base (×5 per attempt) |
| `DUMP_LEDGER_WEBHOOK_MAX_ATTEMPTS` | `5` | Attempts before exhaustion |

## Operations

- **Watch** `GET /api/v1/webhooks/:id/deliveries` for `exhausted` rows and
  their `lastStatusCode`/`lastError`.
- **Recover** a missed event by reading the feed from the delivery's
  `eventCursor` (`GET /api/v1/events?since=…`) — the feed is always the
  complete record.
- **Rotate** a secret by deleting and recreating the subscription.
- Signing secrets are stored plaintext in `ledger.sqlite` (see
  [security-model.md](security-model.md)); protect the data directory as
  instance-private. SSRF control is the operator-gated registration gate.

## Boundaries (v1)

- No guaranteed delivery; no subscription-payload transforms; no wake-on-
  intake channel (tick-driven only); subscription CRUD is operational
  configuration — no audit events, outside the TLA+ model.
- WH2 candidates, only when a consumer asks: wake-on-intake,
  disable-after-N-exhaustions, delivery metrics, audit trail for
  subscription administration (a TLA+ change).

## References

- [webhook-notifications-design.md](webhook-notifications-design.md) —
  design rationale ("why pull, not push" inverted, alternatives).
- [http-api.md](http-api.md#webhooks) — wire contracts.
- [security-model.md](security-model.md) — secrets at rest, SSRF gate.
- [analyzer-integration-design.md](analyzer-integration-design.md) — the AI2
  event feed this taps; AI4 open question resolved by WH1.
- `../Plans/webhook-notifications-plan.md`,
  `../Plans/webhook-notifications-tasks.md` — execution record.
