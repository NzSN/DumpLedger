# Webhook notifications — fine-grained tasks

Derived from [`webhook-notifications-plan.md`](webhook-notifications-plan.md)
and [`../docs/webhook-notifications-design.md`](../docs/webhook-notifications-design.md)
(normative; read it first). Execution via delegated `general-purpose-flash`
agents; one agent per task, disjoint file ownership, self-contained briefs.

## Delegation conventions (all tasks)

- You are NOT alone in the codebase: touch only owned files, never revert
  foreign edits, unrelated dirty work in `git status` is not yours.
- Strict TS (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`),
  NodeNext ESM, explicit `.js` extensions on relative imports,
  `node:test` + `node:assert/strict`, match surrounding style.
- Build discipline: contracts tasks build only `packages/http-contracts`
  (`pnpm --filter @dump-ledger/http-contracts build|test`); backend tasks
  build only the root tsconfig (`tsc -p tsconfig.json`; contracts dist is
  prebuilt — do not run `build:contracts`). Nobody runs root
  `pnpm run build` / `pnpm test` — the integrator runs full gates.
- Report: files changed, deliverable interfaces verbatim, test output tail,
  deviations.


## Status

| ID | Task | Depends on | Status |
|---|---|---|---|
| A1 | Webhook contracts | — | ● |
| A2 | Webhook storage + migration 11 | — | ● |
| B1 | Webhook dispatcher | A2 | ● |
| C1 | Routes, application, main wiring | A1, B1 | ● |
| D1 | Documentation | C1 | ● |

Status: ☐ pending · ◐ assigned · ● accepted.

## A1 — Webhook contracts

- **Owns**: `packages/http-contracts/src/webhooks.ts` (new),
  `packages/http-contracts/src/index.ts` (append-only re-export, matching
  how `events.js` is re-exported), `packages/http-contracts/test/webhooks.test.ts` (new).
- **Style references**: `packages/http-contracts/src/events.ts` (header
  comment citing the design doc, MAX_* bounds, decode/encode pairs over
  `./decode.js` primitives), one existing contract test.
- **Deliver**:
  1. `decodeCreateWebhookParams` for `POST /api/v1/webhooks`:
     `{ url, actions?, caseId? }`; url non-whitespace ≤ 2048; actions ≤ 32
     entries each ≤ 64 chars non-whitespace (mirror events.ts filter
     bounds); caseId decoded like ids in other modules; unknown keys
     rejected like every shared decoder.
  2. `WebhookSubscription` shape + decoder: `{ id, url,
     actions: string[] | null, caseId: string | null, cursor, createdAt }`
     (cursor = zero-padded rowid string; createdAt canonical timestamp).
     No `secret` field.
  3. `decode/encodeCreateWebhookResponse`: `{ subscription, secret }`.
  4. `decode/encodeWebhookListResponse`: `{ subscriptions: [...] }` with a
     4096-item ceiling (events.ts MAX_EVENT_RESPONSE_ITEMS convention).
  5. `WebhookDelivery` shape + decoder: `{ id, subscriptionId, eventCursor,
     action, dumpId: string | null, status: "pending" | "delivered" |
     "exhausted", attempts, lastStatusCode: number | null, lastError:
     string | null, nextAttemptAt: string | null, deliveredAt: string |
     null, createdAt }`; status is a validated closed union.
  6. `decode/encodeWebhookDeliveriesResponse`: `{ deliveries: [...] }`,
     same ceiling.
  7. Tests: happy paths, every bound violation, unknown-key rejection,
     closed-union status rejection, null-vs-absent nullable fields,
     encoder round-trips.

## A2 — Webhook storage + migration 11

- **Owns**: `src/ledger/migrations.ts` (append migration 11 only, SQL
  verbatim from the design doc's storage block, comment in existing style),
  `src/webhooks/storage.ts` (new: `WebhookSubscriptionRecord`,
  `WebhookDeliveryStatus` = "pending"|"delivered"|"exhausted",
  `WebhookDeliveryRecord`, `WebhookStorage` interface),
  `src/webhooks/sqlite-storage.ts` (new: `SqliteWebhookStorage implements
  WebhookStorage`, constructed with the better-sqlite3 `Database`, importing
  its type the same way `src/ledger/sqlite-ledger.ts` does),
  `src/ledger/sqlite-ledger.ts` (ADDITIVE ONLY: private field
  `new SqliteWebhookStorage(this.database)` + public
  `webhookStorage(): WebhookStorage`; change nothing else),
  `src/engine/dump-ledger-engine.ts` (ADDITIVE ONLY:
  `webhookStorage(): WebhookStorage` on the DumpLedgerEngine interface with
  a one-line comment citing the design doc, plus Engine delegate; re-export
  webhook types the way ledger types like AuditFeedEntry are handled),
  `test/unit/webhook-sqlite-storage.test.ts` (new),
  `test/unit/migrations.test.ts` (update ONLY the expected version array
  [1..10] → [1..11]).
- **Storage capabilities** (house-style names; keep signatures obvious for
  wave B):
  - `createSubscription({ subscriptionId, url, secret, actions:
    readonly string[] | null, caseId: string | null, cursorRowid,
    createdAt })` → record; actions as JSON array or NULL; unknown caseId
    → `DumpLedgerError("invalid_input", …)` (translate the FK failure).
  - `listSubscriptions()` ordered by (created_at, subscription_id);
    `findSubscription(id)` → record | null; `deleteSubscription(id)` →
    boolean (deliveries cascade via FK).
  - `listDeliveries(subscriptionId, limit)` most-recent-first
    (created_at DESC, delivery_id DESC), limit clamped 1..500.
  - `findDelivery(subscriptionId, eventRowid)` → record | null (backs the
    UNIQUE idempotent-retry pair).
  - `createDelivery({ deliveryId, subscriptionId, eventRowid, action,
    dumpId, createdAt })` → pending, attempts 0.
  - `markDelivered(deliveryId, statusCode, deliveredAt)`;
    `markRetryScheduled(deliveryId, attempts, { statusCode, error },
    nextAttemptAt)` (stays pending); `markExhausted(deliveryId, attempts,
    { statusCode, error }, now)` (next_attempt_at NULL, delivered_at NULL).
  - `advanceCursor(subscriptionId, eventRowid)`;
    `auditLiveEdge()` → `COALESCE(MAX(rowid), 0)` over audit_events.
  - snake_case rows → camelCase records; Number() rowid guards like
    existing ledger code.
- **Tests**: real `SqliteLedger` at `:memory:` (copy the construction from
  an existing unit test), storage via `ledger.webhookStorage()`. Cover
  create/find/list ordering, unknown-case rejection, delete cascade,
  delivery lifecycle pending → retry-scheduled → delivered and →
  exhausted, findDelivery idempotency, advanceCursor, auditLiveEdge empty
  and after a minimal direct-SQL audit_events insert.

## B1 — Webhook dispatcher (after A2)

- **Owns**: `src/webhooks/dispatcher.ts` (new),
  `test/unit/webhook-dispatcher.test.ts` (new).
- **Style references**: `src/intake/post-processing-queue.ts` and
  `src/http/runtime-jobs.ts` (injectable schedule/cancel, close()
  semantics); the shipped `src/webhooks/storage.ts` (A2) for the storage
  interface; `src/ledger/sqlite-ledger.ts` for `AuditFeedEntry`.
- **Deliver** `WebhookDispatcher` per the design doc's "Delivery semantics"
  and "Wire format" sections:
  - Options: `{ source, storage, tickMs? = 2000, timeoutMs? = 10000,
    retryBaseMs? = 10000, maxAttempts? = 5, pageSize? = 500, fetch?,
    now?, newDeliveryId?, schedule?, cancel? }` — fetch/now/id/scheduler
    injectable; `source` is a narrow structural interface with the engine's
    `readAuditEvents(afterRowid?, filter?, limit?)` signature (caseId in
    the filter is the branded `CaseId`; accept the engine's
    `AuditFeedFilter` type).
  - Tick: for each subscription (creation order), read one page after
    `cursorRowid` with the subscription's actions/caseId filter, deliver
    events strictly in rowid order. A failure stops that subscription's
    page (head-of-line blocking); other subscriptions proceed. No
    overlapping ticks (async guard).
  - Per event: reuse the existing pending delivery row (findDelivery) or
    createDelivery; skip while `nextAttemptAt` is in the future; POST the
    feed-shaped Event JSON (`cursor` = 16-digit zero-padded rowid) with
    headers per design (X-DumpLedger-Event, X-DumpLedger-Delivery,
    X-DumpLedger-Delivered-At, X-DumpLedger-Signature-256 =
    `sha256=<hex HMAC-SHA256 of raw body keyed by secret>`,
    User-Agent DumpLedger-Webhook/1); AbortController timeout.
  - 2xx → markDelivered + advanceCursor. Failure → attempts+1; attempts
    >= maxAttempts → markExhausted + advanceCursor past the event;
    else markRetryScheduled with nextAttemptAt = now +
    retryBaseMs * 5^(attempts-1).
  - `start()` / `close()` (no tick after close; in-flight attempt finishes
    but its result is applied only if still open — simplest safe rule:
    apply regardless, storage is durable) and `snapshot()` counters
    (delivered, exhausted, retries) in the PostProcessingQueue style.
- **Tests**: fake source/storage/fetch/scheduler (drive ticks manually).
  Cover ordering, head-of-line blocking, backoff dues (not due → skipped),
  exhaustion advancing the cursor, timeout → retry, non-2xx → retry,
  signature correctness against a known HMAC, close() quiescence.

## C1 — Routes, application, main wiring (after A1 + B1)

- **Owns**: `src/http/routes/webhook-routes.ts` (new),
  `src/http/application.ts` (additive methods only),
  `src/http/server.ts` (route registration only),
  `src/main.ts` (additive env parsing + dispatcher lifecycle only),
  `test/integration/http-webhook-routes.test.ts` (new),
  `test/integration/webhook-delivery.test.ts` (new).
- **Style references**: `src/http/routes/event-routes.ts` (guard +
  decode + application call + contractErrorFor envelope),
  `src/http/contracts/json.ts` (`jsonRequireSession`,
  `jsonRequireMutation`, `sendError`),
  `test/integration/http-event-routes.test.ts` (fixture pattern: real
  engine at :memory:, MemoryVault, buildHttpServer, session cookie),
  `src/main.ts` (env parsing + PeriodicRuntimeJob wiring pattern).
- **Deliver**:
  - Routes per the design doc's management-API table:
    `POST /api/v1/webhooks` (201, returns `{ subscription, secret }`;
    secret only here), `GET /api/v1/webhooks`,
    `DELETE /api/v1/webhooks/:webhookId` (204; 404 via not_found),
    `GET /api/v1/webhooks/:webhookId/deliveries` (latest 50). All four
    operator-session-only (`jsonRequireSession`); mutations also
    `jsonRequireMutation`. Analyzer bearer token must NOT work.
  - Application methods generating ids/secrets via node:crypto
    (`whs_` + 16 random bytes base64url; `whd_` same; secret `whsec_` +
    32 bytes base64url), validating URL (http/https only, no userinfo,
    ≤ 2048) at the boundary, starting new subscriptions at
    `storage.auditLiveEdge()`, stripping secrets from list responses,
    shaping wire responses via the A1 contracts encoders.
  - main.ts: envs `DUMP_LEDGER_WEBHOOKS` (exactly `on` enables; unset
    otherwise), `DUMP_LEDGER_WEBHOOK_TICK_MS` (2000),
    `DUMP_LEDGER_WEBHOOK_TIMEOUT_MS` (10000),
    `DUMP_LEDGER_WEBHOOK_RETRY_BASE_MS` (10000),
    `DUMP_LEDGER_WEBHOOK_MAX_ATTEMPTS` (5) via the existing
    positiveIntegerEnvironment helper; construct B1's WebhookDispatcher
    over the engine (source = engine's readAuditEvents, storage =
    engine.webhookStorage()), start after listen, close in the shutdown
    path before engine.close(). When disabled, no dispatcher is built and
    routes still work.
  - Integration tests: (a) http-webhook-routes.test.ts — full CRUD through
    the real server, session-only auth proven (analyzer token rejected),
    validation errors, secret-once (list omits it), delete cascade →
    deliveries 404/empty; (b) webhook-delivery.test.ts — real engine +
    real loopback `node:http` receiver + real dispatcher with tiny tick;
    drive intake by engine commands through AcceptDump (copy the command
    sequence from an existing engine/integration lifecycle test); assert
    exactly one signed POST with action AcceptDump, correct HMAC against
    the creation-time secret, dumpId matching, feed-shaped body.
- **Note**: main.ts currently has no way to pass the dispatcher in tests;
  delivery tests construct the dispatcher directly over the engine, NOT
  through main().

## D1 — Documentation (after C1)

- **Owns**: `docs/http-api.md` (route inventory + authentication table
  entries: Operator-session-only webhook routes), `docs/security-model.md`
  (SSRF gate = operator-only registration; webhook secrets at rest in
  ledger.sqlite; signature verification contract),
  `README.md` (the five `DUMP_LEDGER_WEBHOOK*` env variables in the
  existing env style), `docs/analyzer-integration-design.md` (AI4 open
  question gains a pointer: webhooks landed as WH1, see
  docs/webhook-notifications-design.md).
- Match each document's existing section style; additive edits only.
