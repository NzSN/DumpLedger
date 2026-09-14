# Batch upload design

Status: implemented (design decisions 1–4 resolved 2026-09-14; shipped in the
same change series). Extends the one-time upload grant (architecture, Intake;
product design, public upload) so one grant link can deliver several dumps.

## Purpose and scope

Today one upload grant authorizes exactly one dump: `BeginUpload` flips the
grant to `consumed` and every subsequent attempt fails. Operators handling a
customer with several crash dumps must mint and share one link per file.

Batch upload makes the grant **multi-slot**: one secret, one link, up to N
dumps. The byte transport is deliberately unchanged — one dump per
`POST /api/v1/uploads` request, raw `application/octet-stream`, streamed
straight into `UploadSession` with no buffering, multipart parsing, or
archive extraction anywhere in the system.

Out of scope: per-case selective sharing, resumable uploads, parallel
client uploads (sequential only), refunding slots for failed uploads.

## Design decisions (resolved)

1. **`maxUploads` capped at 16.** Enforced at the contract decoder, the
   engine, and the SQL schema.
2. **Failed and aborted uploads consume their slot.** Same rule as today's
   one-time grant, restated per slot; prevents infinite-retry abuse on a
   leaked link. Operators issue a fresh grant instead of expecting refunds.
3. **Slot exhaustion surfaces a distinct client error
   `grant_slots_exhausted`** rather than collapsing into
   `grant_unavailable`. The minor information disclosure (holder of a
   valid-but-exhausted secret learns the link was real and is full) is
   accepted; revoked/expired/unknown secrets still collapse to
   `grant_unavailable`.
4. **Sequential client uploads only.** The upload page streams one file at
   a time. The process-wide admission semaphore (capacity 2) is shared
   with other users; parallel batch uploads would mostly manufacture
   `upload_busy` for everyone else.

## Vocabulary

Per CONTEXT.md discipline, new domain terms are fixed here:

**Grant slot**:
One unit of upload authorization on an upload grant. `BeginUpload` consumes
exactly one slot, whether the stream seals, exceeds `maxBytes`, or aborts.
_Avoid_: upload credit, attempt

**Batch grant**:
An upload grant issued with `maxUploads` > 1. A grant with `maxUploads` = 1
is today's one-time grant — a degenerate case, not a legacy path.
_Avoid_: multi-link, shared grant

## Core mechanism

The grant becomes multi-use; everything downstream of `BeginUpload` is
untouched. Each consumed slot runs the full existing lifecycle
independently: staging object → `SealUpload` → promote → quarantine →
inspection → `available`/`rejected`, with its own audit events.

### Ledger

One migration adds two columns to `upload_grants`:

```sql
ALTER TABLE upload_grants ADD COLUMN max_uploads INTEGER NOT NULL DEFAULT 1
  CHECK (max_uploads BETWEEN 1 AND 16);
ALTER TABLE upload_grants ADD COLUMN uploads_used INTEGER NOT NULL DEFAULT 0;
```

`DEFAULT 1` preserves one-time semantics for every existing row.

`beginUpload` becomes a single atomic UPDATE (the single-writer SQLite
connection makes it race-free; two requests contending for the last slot
produce exactly one winner):

```sql
UPDATE upload_grants
SET uploads_used = uploads_used + 1,
    state = CASE WHEN uploads_used + 1 >= max_uploads
                 THEN 'consumed' ELSE 'issued' END,
    consumed_by_dump_id = COALESCE(consumed_by_dump_id, ?)
WHERE grant_id = ? AND state = 'issued' AND uploads_used < max_uploads
```

`.changes !== 1` → `grant_consumed`. The existing
`grant_terminal_state_immutable` trigger is unaffected (`issued→issued` and
`issued→consumed` both pass). `consumed_by_dump_id` keeps its audit meaning
(first consuming dump); the full grant→dumps set is derivable from dump
rows.

### Engine

`BeginUpload` pre-checks are unchanged (digest lookup, expiry, `issued`
state). Slot exhaustion is enforced atomically by the ledger UPDATE above,
not by a read-then-write in the engine. No new engine commands.

## HTTP surface

### Grant issuance (operator)

`CreateGrantRequest` gains an optional `maxUploads` integer, 1..16, default
1 — old clients decode unchanged. New constant
`MAX_GRANT_MAX_UPLOADS = 16` in the grants contract, mirrored by the SQL
CHECK and the engine assert.

`GrantRecord` gains `maxUploads` and `uploadsUsed`; decoders default them
to 1 and 0 so a new frontend tolerates an old server during rollout.

### Upload (public) — unchanged endpoint

`POST /api/v1/uploads` keeps its exact current shape: one dump per request,
`X-Upload-Grant` and `X-Dump-Filename-Base64url` headers, raw streamed
body, per-request `UploadAdmission` lease. The secret simply remains valid
for the next request while slots remain.

### Grant quota (public, new)

```text
GET /api/v1/uploads/quota
X-Upload-Grant: <base64url-secret>

200 { maxUploads, uploadsUsed, maxBytes, expiresAt }
```

Secret-gated (the uploader already holds the secret, so nothing new is
disclosed), rate-limited by the existing `uploadGrantRateLimiter`. Returns
200 for `issued` **or** `consumed` grants so the page can render "0 of 3
remaining"; `grant_unavailable` for revoked, expired, or unknown secrets.
The upload page uses it to cap file selection and to explain exhaustion
before a byte is streamed.

### Error surface

New stable code `grant_slots_exhausted` in `HTTP_ERROR_CODES`:

- Status **404** (same as `grant_unavailable`; the distinction travels in
  the code, not the status).
- Fixed message: "This upload link has no remaining upload slots."
- Not retryable.

Mapping chain: with multi-slot grants, `consumed` is reachable *only* by
exhausting slots, so engine `grant_consumed` ≡ slots-exhausted.
`UploadSession` stops collapsing every begin failure into `grant_invalid`:
lifecycle code `grant_consumed` maps to a new `IntakeErrorCode`
`grant_slots_exhausted`, all other begin failures stay `grant_invalid` →
`grant_unavailable`. Only the public upload route performs this split;
operator-facing `contractErrorFor` keeps mapping `grant_consumed` to
`grant_unavailable`.

**Deliberate asymmetry** (decision 3): an exhausted-but-valid secret earns
the distinct code; revoked/expired/unknown secrets stay indistinguishable.

## Failure and retry semantics

- A begun upload consumes its slot even on failure (`upload_too_large`,
  network drop, browser abort) — decision 2.
- **Partial success is first-class**: a five-file batch ending 3 sealed /
  2 failed is a normal terminal state, reported per file. Never
  all-or-nothing.
- Per-file retry rule unchanged: manual retry only on `503 upload_busy` /
  `429` (the server provably never started the request); every other
  failure directs the customer to request a new link for that slot.
- Revoke, expiry, and case close block all remaining slots; already-sealed
  dumps proceed through inspection normally (existing
  `ClosedCaseHasNoIssuedGrant` semantics).

## Frontend

### Public upload page

- Fragment transport unchanged — still exactly one secret in the URL, read
  into route-local memory and scrubbed on mount.
- On mount, `GET /api/v1/uploads/quota` caps selection at the remaining
  slot count and shows the per-dump byte ceiling.
- File input gains `multiple`; the drop zone accepts multiple files.
- **Strictly sequential queue** (decision 4): one XHR at a time; per-file
  state machine `queued → uploading → sealed/available/rejected | failed`;
  per-file progress plus aggregate progress.
- Leaving the route aborts the in-flight file and cancels queued ones.
- A mid-batch `grant_slots_exhausted` (slots consumed via another tab, or
  the operator revoked and the secret flipped) terminates the remaining
  queue with per-file outcomes preserved; new terminal outcome
  `slots-exhausted` in `upload-outcomes.ts` — no retry, "this link has
  already received all its dumps; ask for a new link".

### Operator grants UI

Create-grant form gains "dumps allowed" (number, default 1, max 16). Grant
list and detail show "3 / 5 slots used". Optional follow-up: per-grant
dump listing.

## Security controls

A leaked link now authorizes up to N dumps within its expiry instead of 1.
Bounds: `maxUploads ≤ 16`; unchanged per-dump `maxBytes` (total ingress ≤
N × maxBytes); unchanged expiry, revoke, and case-close revocation;
process-wide admission cap throttling ingress rate; per-IP grant-attempt
rate limiting unchanged (still one secret, so secret-guessing protection is
unchanged). A 16-file batch is 16 POSTs against that limiter — verify its
threshold accommodates legitimate batches (tuning, not redesign). Every
slot consumption emits the existing `BeginUpload` audit event with the
grant id, so batch uploads are fully attributable. `security-model.md` and
`product-design.md` gain a batch-grant section on merge.

## Formal model

`specs/DumpLedger.tla`: grants gain a slots dimension. `BeginUpload` is
enabled while `uploads_used < max_uploads`, increments it, and the grant
becomes `consumed` at the bound (model with max 2 slots to keep the state
space small). New invariants: slot bounds
`0 ≤ uploads_used ≤ max_uploads`, and dumps-per-grant ≤ `max_uploads`.
`ClosedCaseHasNoIssuedGrant` is unchanged.

Regenerating model-interface bindings and MBT traces is an explicit
maintainer action per AGENTS.md, run once for this change and listed
separately in the PR — never bundled with a test fix.

## Test plan

- **Unit** (ledger/engine): slot decrement, exhaustion race (two begins,
  one slot), terminal-state trigger immutability, migration back-fill of
  existing rows to 1/0, failed upload consuming a slot.
- **Integration**: full K-file batch end to end; revoke mid-batch; expiry
  mid-batch; `upload_too_large` consuming a slot; two batches contending
  for admission; quota endpoint for issued/consumed/revoked/expired
  secrets.
- **Contract**: `maxUploads` round-trips and bounds; `GrantRecord`
  defaults under an old server; `grant_slots_exhausted` decodes;
  old-client `CreateGrantRequest` without `maxUploads`.
- **Frontend (Vitest)**: queue transitions, abort on route leave, partial
  failure rendering, quota-capped selection, `slots-exhausted` outcome.
- **E2E (Playwright)**: 3-slot grant → 3 files → all `available`; a 4th
  attempt → `grant_slots_exhausted`, first three unaffected.

## Alternatives considered and rejected

- **Multipart single request** — breaks the raw-stream/no-buffer
  transport; all-or-nothing failure; per-part limits and per-file progress
  get murky.
- **Tar/zip bundle** — server-side extraction attack surface (bombs, path
  traversal); one integrity failure kills every dump; per-member hashing
  and limits reimplement multipart worse.
- **N independent one-time grants with a client-side loop** — zero server
  change and works today, but the operator mints and copies N links and
  the customer juggles N URLs (or N secrets in one fragment, each burnable
  by a single abort). Remains the documented zero-change fallback.

## Implementation milestones

Single phase:

1. Migration + ledger atomic slot decrement.
2. Contracts: `maxUploads`, `GrantRecord` fields, quota endpoint,
   `grant_slots_exhausted`.
3. `UploadSession`/upload-route error split; quota route.
4. Sequential multi-file upload page + operator grants UI.
5. TLA+ slots + invariants; maintainer-run binding and trace regen.
6. All test tiers per the test plan; docs updates (`CONTEXT.md`,
   `product-design.md`, `security-model.md`).

## Compatibility and migration safety

The change is purely additive; existing deployed data is not rewritten:

- The migration is two `ALTER TABLE upload_grants ADD COLUMN` statements
  applied in one versioned, transactional step by `applyMigrations`. No
  drops, renames, or table rebuilds; a failure leaves the database
  untouched.
- Existing rows take the defaults (`max_uploads` = 1, `uploads_used` = 0),
  which satisfy the new CHECK, so every outstanding `issued` grant behaves
  exactly as today's one-time grant. Terminal-state grants and the
  `grant_terminal_state_immutable` trigger are unaffected.
- Rollback to the pre-batch build does not corrupt data: old INSERTs use
  explicit column lists (new columns default), and row decoders read named
  keys. Degradation only: under rolled-back code a batch grant collapses
  to one-time on its next upload.
- Transfer import/export: old export bundles import into the new schema
  unchanged (grant fields default). The transfer grant record must gain
  defaulted `maxUploads`/`uploadsUsed` so a partially used batch grant
  survives export/import; this is part of milestone 2.
- Deployment: stop the service and copy `ledger.sqlite` aside before
  upgrading, per the repo's backup discipline; the vault is untouched.
