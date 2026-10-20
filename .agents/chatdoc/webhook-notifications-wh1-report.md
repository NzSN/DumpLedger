# WH1 milestone gate report — Webhook notifications

Date: 2026-10-20 · Status: WH1 complete, all five tasks accepted.

Resolves the AI4 open question ("long-poll or webhooks if pull proves
insufficient") for the concrete case: notify an external analyzer that a new
dump was uploaded — without polling. Canonical design:
[`../../docs/webhook-notifications-design.md`](../../docs/webhook-notifications-design.md);
execution records:
[`../../Plans/webhook-notifications-plan.md`](../../Plans/webhook-notifications-plan.md),
[`../../Plans/webhook-notifications-tasks.md`](../../Plans/webhook-notifications-tasks.md).

## The mechanism in one paragraph

**Tap, not truth.** The AI2 audit event feed stays the resumable source of
truth; webhooks are a low-latency push tap. An in-process `WebhookDispatcher`
follows `audit_events` through the engine's existing `readAuditEvents` keyset
read — read-only, no engine command, no TLA+ action, no projection change —
and POSTs matching events to operator-registered URLs, signed with a
per-subscription HMAC secret. Per-subscription durable cursor: restarts
resume where delivery stopped; exhausted deliveries stay recoverable through
the feed.

## What was delegated and delivered

| Task | Delivered | Evidence |
|---|---|---|
| A1 webhook contracts | `packages/http-contracts/src/webhooks.ts` — create/list/deliveries decoders+encoders, closed status union, URL/filter bounds; 27 tests | contracts suite green |
| A2 storage + migration 11 | `webhook_subscriptions` + `webhook_deliveries` (UNIQUE(subscription_id, event_rowid) idempotent-retry pair); `src/webhooks/{storage,sqlite-storage}.ts`; ledger/engine `webhookStorage()` seam | storage 5/5, migrations 4/4 |
| B1 dispatcher | `src/webhooks/dispatcher.ts` — ordered per-subscription delivery, head-of-line blocking, `base×5^(n-1)` backoff dues, exhaustion advancing the cursor, AbortController timeout, HMAC-SHA256 over raw body, injectable fetch/scheduler/clock/ids | 9/9 unit tests |
| C1 routes + wiring | Four operator-session routes (`POST/GET /api/v1/webhooks`, `DELETE …/:id`, `GET …/deliveries`); application id/secret minting (`whs_`/`whd_`/`whsec_`); five `DUMP_LEDGER_WEBHOOK*` envs; dispatcher lifecycle in `main.ts` | routes 4/4 + end-to-end 1/1 |
| D1 documentation | `docs/http-api.md` (inventory + auth labels), `docs/security-model.md` (SSRF gate, secrets at rest, signature contract), `README.md` envs, AI4 pointer in `analyzer-integration-design.md` | 4 docs, additive-only |

## Gate results (integrator-run)

- typecheck clean (contracts + web + backend) · build green
- unit **167/167** · integration green · MBT **28/28**
- `check:model-interface` clean — no model inputs touched, as designed
- Full `pnpm test` green end-to-end (final run)
- End-to-end proof: real engine driven through `AcceptDump`, real loopback
  HTTP receiver — exactly one signed POST, correct HMAC, feed-shaped body
- Integrator fixes outside worker scope: two pre-existing schema-version
  assertions (`test/integration/ledger-catalog.test.ts`,
  `test/integration/engine-analysis.test.ts`) updated `[1..10]` → `[1..11]`
- Sandbox note: `webhook-delivery.test.ts` binds a loopback listener and
  needs an unsandboxed run (`listen EPERM` inside the sandbox)

## Delivery semantics (normative summary)

- Ordered, at-least-once, head-of-line blocking per subscription; a failure
  stops that subscription's page, other subscriptions proceed.
- Retry at 10 s → 50 s → ~4 m → ~21 m; after 5 attempts the delivery is
  `exhausted` (visible in `GET …/deliveries`), cursor advances, feed remains
  the recovery path.
- Body is exactly the feed `Event` shape; headers `X-DumpLedger-Event`,
  `-Delivery`, `-Delivered-At`, `-Signature-256`, `User-Agent:
  DumpLedger-Webhook/1`. Receiver verifies: `HMAC_SHA256(secret, raw body)`,
  constant-time compare.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DUMP_LEDGER_WEBHOOKS` | off | `on` starts the dispatcher |
| `DUMP_LEDGER_WEBHOOK_TICK_MS` | 2000 | poll interval |
| `DUMP_LEDGER_WEBHOOK_TIMEOUT_MS` | 10000 | per-attempt HTTP timeout |
| `DUMP_LEDGER_WEBHOOK_RETRY_BASE_MS` | 10000 | backoff base (×5 per attempt) |
| `DUMP_LEDGER_WEBHOOK_MAX_ATTEMPTS` | 5 | attempts before exhaustion |

Enable + subscribe: `DUMP_LEDGER_WEBHOOKS=on`, then as operator
`POST /api/v1/webhooks { "url": "http://analyzer:4180/webhooks",
"actions": ["AcceptDump"] }` — the returned `secret` is shown once.

## Boundaries and next gates

- v1 boundaries (documented, not silently skipped): no guaranteed delivery
  (feed is truth); no audit trail for subscription CRUD (operational config,
  outside the TLA+ model); tick-driven, no wake-on-intake channel; analyzer
  bearer token is not accepted on webhook routes.
- Working tree only — nothing committed or pushed; `.projectile-cache.eld`
  remains unrelated pre-existing dirty state.
- Next gate candidates: commit · live fire drill against DumpAnalyzer · WH2
  (wake-on-intake, admin audit trail, disable-after-N-exhaustions).
