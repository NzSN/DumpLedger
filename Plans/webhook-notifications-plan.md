# Webhook notifications execution plan

Derived from [`docs/webhook-notifications-design.md`](../docs/webhook-notifications-design.md).
Covers milestone WH1. Work is decomposed into waves of tasks with disjoint
file scopes so independent tasks run in parallel. Dependencies: B1 builds on
A2's storage interface; C1 builds on A1's contracts and B1's dispatcher.

## Conventions for every task

- Follow AGENTS.md: strict TS (`noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`), explicit `.js` extension imports,
  `node:test` + `node:assert/strict`, tests run from `dist/` (build first).
- Contracts package builds first when a task touches it; backend tasks build
  with `tsc -p tsconfig.json` only.
- Acceptance = scoped tests green + typecheck clean, plus the wave gate.
- Never revert or modify files outside the task's stated scope; unrelated
  uncommitted work must survive untouched.
- Documentation obligations land in the same wave as the capability (wave D).
- No TLA+/MBT changes in WH1: webhooks are an operational tap outside the
  model. `pnpm run check:model-interface` must stay green untouched.

## Wave A — contracts and storage foundations (parallel)

| Task | Scope (owns) | Delivers |
|---|---|---|
| **A1 webhook contracts** | `packages/http-contracts/src/webhooks.ts` (new), `packages/http-contracts/src/index.ts` (append only), `packages/http-contracts/test/webhooks.test.ts` (new) | `CreateWebhookParams`/`WebhookSubscription`/`CreateWebhookResponse`/`WebhookListResponse`/`WebhookDelivery`/`WebhookDeliveriesResponse` decoders+encoders; URL/action/caseId bounds per design; delivery-status vocabulary |
| **A2 webhook storage + migration 11** | `src/ledger/migrations.ts` (append migration 11 only), `src/webhooks/storage.ts` (new, interface + record types), `src/webhooks/sqlite-storage.ts` (new), `src/ledger/sqlite-ledger.ts` (additive seam only), `src/engine/dump-ledger-engine.ts` (additive `webhookStorage()` only), `test/unit/webhook-sqlite-storage.test.ts` (new), `test/unit/migrations.test.ts` (version list update only) | Migration 11 (`webhook_subscriptions`, `webhook_deliveries`); `WebhookStorage` CRUD + delivery state transitions + cursor ops; live-edge cursor at creation; engine read-through |

Wave A gate: `pnpm run typecheck && tsc -p tsconfig.json && node --test dist/test/unit/webhook-sqlite-storage.test.js dist/test/unit/migrations.test.js` plus contracts package tests.

## Wave B — dispatcher (after A2)

| Task | Scope (owns) | Delivers |
|---|---|---|
| **B1 webhook dispatcher** | `src/webhooks/dispatcher.ts` (new), `test/unit/webhook-dispatcher.test.ts` (new) | Tick-driven feed follower: per-subscription ordered delivery, head-of-line blocking, exponential backoff with dues, exhaustion with cursor advance, HMAC-SHA256 signature, timeout via AbortController, injectable fetch/scheduler/clock/ids, `snapshot()` counters |

Wave B gate: dispatcher unit tests green + typecheck.

## Wave C — HTTP surface and wiring (after A1 + B1)

| Task | Scope (owns) | Delivers |
|---|---|---|
| **C1 routes, application, main wiring** | `src/http/routes/webhook-routes.ts` (new), `src/http/application.ts` (additive), `src/http/server.ts` (registration only), `src/main.ts` (additive env + dispatcher lifecycle only), `test/integration/http-webhook-routes.test.ts` (new), `test/integration/webhook-delivery.test.ts` (new) | Four operator-session routes per design table; application methods generating id/secret and shaping contract responses; `DUMP_LEDGER_WEBHOOK*` env parsing; dispatcher constructed/started/closed with the server; end-to-end signed `AcceptDump` delivery against a loopback receiver |

Wave C gate: scoped integration tests green + `pnpm run test:unit`.

## Wave D — documentation and full gate (after C1)

| Task | Scope (owns) | Delivers |
|---|---|---|
| **D1 documentation** | `docs/http-api.md` (route inventory + authentication table), `docs/security-model.md` (SSRF gate, secrets at rest), `README.md` (env variables), `docs/analyzer-integration-design.md` (AI4 open-question pointer to the new design) | Webhook surface documented where operators actually look |

Wave D gate (integrator): `pnpm test` full gate — typecheck, model-interface
check, build, unit, integration, MBT.
