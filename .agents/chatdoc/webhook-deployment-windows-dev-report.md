# Deployment report — webhook notifications on windows-dev (WH1+WH2)

Date: 2026-10-20 · Status: deployed and verified live.

First production deployment of the webhook design
([WH1](../../docs/webhook-notifications-design.md),
[WH2](../../docs/webhook-admin-token-design.md)) to the DumpLedger instance
on the windows-dev machine (`/d/Services/dump-ledger`, runtime
`/d/Services/dump-ledger-runtime`).

## Before / after

| | Before | After |
|---|---|---|
| Checkout | `7c2a51b` (pre-webhook) | `444cf1b` (WH1+WH2) |
| `/api/v1/webhooks` probe | `404` (route absent) | `401` (deployed, rejects anonymous) |
| `/api/v1/events` probe | `401` | `401` (unchanged) |
| `schema_migrations` | 10 | 11 |
| Webhook envs | none | `DUMP_LEDGER_WEBHOOKS=on`, `DUMP_LEDGER_WEBHOOK_ADMIN_TOKEN_HASH` set |

## Data-safety evidence

- Online backup of the live ledger first:
  `D:/Services/dump-ledger-runtime/backups/ledger-pre-444cf1b.sqlite`.
- Baseline (v10): 20 customers, 18 cases, 30 grants, 128 dumps, 942 audit
  events, 13 symbol artifacts, 34 analyses.
- Dry-run on a copy of the backup with the new build: migration 10 → 11
  applied, `integrity_check = ok`, `foreign_key_check` empty, **all counts
  identical**, `webhook_subscriptions` / `webhook_deliveries` present and
  empty. Probe script: runtime `tmp/wh-dryrun.mjs` (may be deleted).

## Deploy steps executed

1. `git pull --ff-only` → `444cf1b`; lockfile unchanged, `pnpm run build`.
2. Runtime `.env` appended: `DUMP_LEDGER_WEBHOOKS=on` and the admin-token
   digest (value not recorded here).
3. Backend restarted via the established
   `name-upgrade-scripts/start-backend.sh` (old PID 51868 stopped; TLS
   proxy on 4080 untouched the whole time).

## Live verification

- Probes as in the table above; live `MAX(schema_migrations) = 11`.
- End-to-end admin-token proof on the live instance: bearer `POST` created
  subscription `whs_LPA8LtgbgAJUHmrrB55j1w` (201), `GET` list → 200,
  `DELETE` → 204 with cascade; tables empty afterwards.
- Backend log shows a clean boot (symbols listener line, no errors).

## Token and secret locations

- Webhook-admin token: `/home/nzsn/.dump-ledger-webhook-admin-token`
  (mode 600, local machine) — move to DumpAnalyzer's secret store when its
  receiver exists. Digest configured on the instance; token never written
  to chat logs.
- Remote copy used for the live probe was deleted after use.

## Current state and next steps

Dispatcher ticking with zero subscriptions (idle-but-ready). Next: point
DumpAnalyzer at it once it grows a receiver — registration is hot-plug, no
restart. Rollback path: `DUMP_LEDGER_WEBHOOKS` off + restart; delete
subscriptions; webhook tables are inert.
