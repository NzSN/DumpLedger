# Webhook-admin token design

Status: shipped as milestone WH2 (2026-10-20). Resolves the WH1 limitation
that webhook administration requires an operator browser session, which makes
DumpAnalyzer-style self-registration impossible. Related:
[webhook-notifications-design.md](webhook-notifications-design.md) (WH1),
[analyzer-integration-design.md](analyzer-integration-design.md) (token
precedent this mirrors).

## Goal and non-goals

**Goal.** A machine caller holding a dedicated bearer credential can create,
list, inspect deliveries of, and delete webhook subscriptions — no cookie, no
CSRF round-trip — so DumpAnalyzer registers itself at deploy time.

**Non-goals (WH2).**

- Per-caller subscription ownership (the admin credential manages **all**
  subscriptions, exactly like the operator session; see "Ownership").
- URL allowlists for bearer-registered endpoints (deferred hardening, WH3
  candidate).
- Any change to the analyzer token's scope — the analyzer token stays
  rejected on webhook routes (decision recorded below).

## The credential

A third token in the established pattern (ingest, analyzer):

- Operator generates a high-entropy token; only its sha256 hex digest is
  configured: `DUMP_LEDGER_WEBHOOK_ADMIN_TOKEN_HASH`. Unset or empty disables
  the bearer path entirely; a malformed digest fails boot fast.
- Digest at rest, constant-time compare — `src/auth/webhook-admin-token.ts`
  mirrors `src/auth/analyzer-token.ts` line for line.
- `npm run generate:webhook-admin-token` prints token + digest, mirroring
  `tools/generate-ingest-token.ts`.

## Authorization model

All four `/api/v1/webhooks` routes gain **pinned dual auth** via a new
`authorizeSessionOrWebhookAdmin` (+ `…Mutation`) guard in
`src/http/contracts/json.ts`, mirroring `authorizeSessionOrAnalyzer`:

- Any `Authorization` header selects the bearer path **only**: a malformed or
  wrong token is a generic 401 even alongside a valid operator session cookie
  — no fall-through. This precedence is pinned, as with the analyzer token.
- Without the header, the existing operator session (+ CSRF, Origin, Fetch
  Metadata on mutations) guard applies **unchanged**.
- Bearer requests carry no cookie semantics: no CSRF/Origin evidence is
  checked on that path — a machine caller has no ambient browser authority.

Scope is exactly the four webhook routes — nothing else. The credential
grants no catalog, feed, dump, or symbol access; it is independent of the
analyzer token, and the two rotate independently.

## Why not the analyzer token (decision record)

Considered and rejected in WH1 discussion; recorded here so it stays
rejected deliberately:

1. **SSRF probing oracle** — registration makes the server originate POSTs to
   arbitrary URLs; `lastStatusCode`/`lastError` in the deliveries list is a
   LAN reachability oracle. Feed pulls never call outbound.
2. **Dispatcher DoS surface** — subscriptions are processed sequentially per
   tick; a black-hole endpoint costs up to `TIMEOUT_MS` per attempt and
   degrades every other subscriber.
3. **Durability asymmetry** — rotating a compromised analyzer token ends its
   feed access immediately, but a subscription it registered keeps pushing
   until manually deleted. Token rotation must stay effective.
4. **Scope hygiene** — the analyzer token's documented threat model is
   "reads + verdicts"; infrastructure administration is a different
   privilege class and deserves a separately revocable credential.

## Ownership

The admin token is an **operator-class infrastructure credential**: it lists
and manages all subscriptions, same as the browser session. For the intended
deployment (one DumpAnalyzer per instance, issued its token by the same
operator) this is exact. Per-caller ownership (analyzer A cannot see B's
subscriptions) is a WH3 question, only if mutually-distrusting consumers
appear.

## Residual risks (accepted, documented in security-model.md)

- **Push-anywhere** remains: the admin token can aim deliveries at any URL.
  Accepted because issuance is operator-gated like the grant key; the
  deliveries list makes misuse operator-visible. The URL allowlist remains
  available as WH3 hardening if the token is ever issued more broadly.
- **Rotation does not revoke subscriptions.** Decommission procedure:
  `DELETE /api/v1/webhooks/:id` for the caller's subscriptions, then rotate
  the token digest. Documented in README and analyzer-guide.

## Self-registration flow (the point of WH2)

DumpAnalyzer at boot, holding its admin token:

1. `GET /api/v1/webhooks` (Bearer) — find an existing subscription for its
   own URL; keep it if present (idempotent re-registration).
2. Else `POST /api/v1/webhooks` (Bearer) with its endpoint and
   `actions: ["AcceptDump"]`; persist the returned `secret` in its own
   secret store (shown once).
3. Verify `X-DumpLedger-Signature-256` on every delivery with that secret;
   dedupe on delivery id / cursor; keep the feed as reconciliation.

## Testing

- Unit: `webhook-admin-token` parse/verify, mirroring
  `test/unit/analyzer-token.test.ts`; generator coverage.
- Integration: bearer create/list/deliveries/delete through the real stack;
  bearer skips CSRF; pinned precedence (bad bearer + good cookie = 401);
  analyzer token still rejected on webhook routes; session path untouched
  (WH1 tests keep passing).

## Milestone WH2

Execution plan: `../Plans/webhook-admin-token-plan.md`. Waves: W1 credential
+ generator, W2 guards/routes/integration, W3 docs + full gate.
