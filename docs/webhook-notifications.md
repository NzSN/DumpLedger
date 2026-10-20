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

All four routes require the **operator session cookie**; the analyzer bearer
token is not accepted. Mutations pass the Origin/Fetch-Metadata guard.

| Route | Purpose |
|---|---|
| `POST /api/v1/webhooks` | Create `{ url, actions?, caseId? }` → `201 { subscription, secret }`. The secret is returned **only here**. |
| `GET /api/v1/webhooks` | List subscriptions (never the secret). |
| `DELETE /api/v1/webhooks/:webhookId` | Remove; delivery rows cascade → `204`. |
| `GET /api/v1/webhooks/:webhookId/deliveries` | Latest 50 delivery rows, newest first — the ops view of retries and exhaustions. |

URL rules: `http:` or `https:`, no userinfo, ≤ 2048 chars. `actions` follows
the feed filter bounds (≤ 32 entries, ≤ 64 chars each); a `caseId` must name
an existing case. Example — subscribe to newly available dumps:

```sh
curl -b cookies.txt -X POST http://127.0.0.1:4080/api/v1/webhooks \
  -H 'Content-Type: application/json' \
  -d '{ "url": "http://analyzer:4180/webhooks", "actions": ["AcceptDump"] }'
```

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
  instance-private. SSRF control is the operator-only registration gate.

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
