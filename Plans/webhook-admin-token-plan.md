# Webhook-admin token execution plan

Derived from [`docs/webhook-admin-token-design.md`](../docs/webhook-admin-token-design.md).
Covers milestone WH2: a dedicated bearer credential for the four webhook
administration routes, so DumpAnalyzer self-registers without an operator
browser session. Small enough for three short waves; delegation via
`general-purpose-flash`, one agent per task, disjoint file ownership.

## Conventions for every task

- Follow AGENTS.md: strict TS (`noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`), explicit `.js` extension imports,
  `node:test` + `node:assert/strict`, tests run from `dist/` (build first).
- Build discipline: backend builds only via `tsc -p tsconfig.json`
  (contracts dist is prebuilt; WH2 adds no contracts). Nobody runs root
  `pnpm run build` / `pnpm test` — the integrator runs full gates.
- Acceptance = scoped tests green + typecheck clean, plus the wave gate.
- Touch only owned files; never revert foreign edits; unrelated dirty work
  (`git status`) is not yours.
- Wave gates are run by the integrator, not self-reported.

## Wave W1 — credential + generator (parallel-safe, single task)

| Task | Scope (owns) | Delivers |
|---|---|---|
| **W1 webhook-admin token module** | `src/auth/webhook-admin-token.ts` (new), `tools/generate-webhook-admin-token.ts` (new), `test/unit/webhook-admin-token.test.ts` (new), `test/unit/secret-generators.test.ts` (extend if it enumerates generators), `package.json` (add `generate:webhook-admin-token` script line only) | `parseWebhookAdminTokenHash` / `verifyWebhookAdminToken` mirroring `src/auth/analyzer-token.ts` exactly (digest at rest, constant-time compare, fail-fast on malformed digest, unset disables); generator printing token + digest |

Wave W1 gate: typecheck + scoped unit tests green.

## Wave W2 — guards, routes, wiring, integration tests (after W1)

| Task | Scope (owns) | Delivers |
|---|---|---|
| **W2 dual-auth webhook routes** | `src/http/contracts/json.ts` (additive guards only), `src/http/routes/webhook-routes.ts` (guard swap only), `src/http/server.ts` (options field only), `src/main.ts` (env parse + pass-through only), `test/integration/http-webhook-routes.test.ts` (extend only) | `authorizeSessionOrWebhookAdmin` / `…Mutation` with pinned bearer precedence mirroring `authorizeSessionOrAnalyzer`; all four routes dual-auth (reads: session or bearer; mutations: session+CSRF or bearer); `DUMP_LEDGER_WEBHOOK_ADMIN_TOKEN_HASH` env wiring fail-fast on malformed; integration coverage: bearer CRUD, bearer skips CSRF, bad bearer + good cookie = 401, analyzer token still rejected, session path unchanged |

Wave W2 gate: scoped integration tests green + `pnpm run test:unit`.

## Wave W3 — documentation + full gate (after W2)

| Task | Scope (owns) | Delivers |
|---|---|---|
| **W3 documentation** | `docs/http-api.md` (auth labels + admin-token note), `docs/security-model.md` (credential, residual risks, rotation/decommission procedure), `README.md` (env var + generator), `docs/webhook-notifications.md` (WH2 auth paragraph), `docs/analyzer-guide.md` (self-registration flow), `docs/webhook-notifications-design.md` (WH2 pointer), `docs/webhook-admin-token-design.md` (status → shipped after gate) | Operator- and analyzer-facing docs match shipped behavior |

Wave W3 gate (integrator): `pnpm test` full gate — typecheck,
model-interface check (must stay clean; WH2 touches no model inputs),
build, unit, integration, MBT.

## Status

| ID | Task | Depends on | Status |
|---|---|---|---|
| W1 | Webhook-admin token module + generator | — | ● |
| W2 | Dual-auth guards, routes, wiring, tests | W1 | ● |
| W3 | Documentation | W2 | ● |

Status: ☐ pending · ◐ assigned · ● accepted.
