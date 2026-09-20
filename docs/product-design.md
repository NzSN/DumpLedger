# Product design

## Purpose

DumpLedger answers one operational question reliably:

> Which customer and support case supplied this dump, and what is safe to do
> with it now?

It is not a general helpdesk. It provides the small subset of case tracking
needed for dump intake, investigation, and retention. It must remain usable by
one operator on one machine while supporting customer uploads over HTTPS when
deployed on a reachable host.

## Product principles

1. **Association is established at intake.** Ownership is never inferred from
   usernames, paths, or strings recovered from process memory.
2. **Original bytes are immutable.** Analysis produces derived artifacts; it
   never rewrites the received dump.
3. **A dump is unavailable until validated.** Completing an HTTP upload is not
   the same as accepting a dump for analysis.
4. **Full memory is a declared capture property, not a completeness promise.**
   A writer flag can request full accessible memory while inaccessible pages or
   transfer truncation still create gaps.
5. **The database is invisible to operators.** All routine actions use the web
   interface or the program's administrative commands.
6. **Deletion is explicit and auditable.** The file can be purged while a
   minimal tombstone remains to explain what happened.

## Current implementation boundary

The TypeScript 7/Node.js 24 baseline implements customer and case creation,
one-time grants, streaming upload, structural inspection, lifecycle display,
case-manifest export, authenticated download, and server-clock-derived
retention deadlines, startup reconciliation, and two-phase purge primitives. A
bounded production job processes explicitly assigned `purge_at` values. The
current web UI exposes the central customer/case/grant/dump paths and basic
operational health.

The following product-design items are still targets rather than shipped
behavior: local operator file import, case notes, external issue links, a direct
purge confirmation flow, automatic coverage-specific retention defaults,
disk/backup health details, coordinated vault backup and restore, and separate
analyst/operator roles. Non-loopback service also depends on an external HTTPS
terminator, and the repository license has not yet been selected.

## Domain language

These terms are normative for the implementation and user interface.

### Customer

An organization or person who supplied diagnostic data. A customer has an
opaque identifier and a display name. The display name is metadata and must not
appear in vault paths.

### Case

A support investigation owned by exactly one customer. A case may contain many
dumps. It has a human-readable title, status, creation time, and optional link
to an external engineering issue.

A case is not necessarily a software bug. Several customer cases may later
refer to the same engineering defect.

### Upload grant

A short-lived authorization bound to exactly one case. Each grant is issued
with a slot count (1–16 dumps, default 1); a one-slot grant is a one-time
grant, and a multi-slot grant is a batch grant shared as a single link (see
`docs/batch-upload-design.md`). The customer receives the grant as an HTTPS
URL. DumpLedger stores only a cryptographic hash of the secret token.

### Dump

An immutable received artifact with a server-generated identifier. Its case,
and therefore its customer, becomes fixed when upload begins. A dump record may
outlive the stored bytes as a deletion tombstone.

### Coverage classification

The classification reported by DumpLedger is one of:

- `partial`: the header does not declare `MiniDumpWithFullMemory`; selected
  memory ranges may still be present.
- `full-memory-declared`: the `MiniDumpWithFullMemory` flag is set. This does
  not claim that inaccessible pages or missing transfer bytes are present.
- `unknown`: coverage cannot be classified safely.

`MiniDumpWithFullMemoryInfo` alone is memory-region metadata and must not be
reported as full captured memory.

### Validation status

- `not-checked`: upload has not reached structural inspection.
- `valid`: required minidump structures and referenced ranges are within the
  stored object.
- `invalid`: parsing or range validation failed.
- `transfer-failed`: the upload did not seal successfully.

`valid` means format-consistent. It does not mean that symbols match, that the
dump is complete, or that a debugger can answer every investigation question.

## Roles

### Operator

Creates customers and cases, issues upload grants, changes case status, sets
retention, and purges dumps.

### Analyst

Views metadata, downloads accepted dumps, records notes, and links an external
engineering issue. The first release may give one local account both operator
and analyst privileges.

### Uploader

Possesses one upload grant. An uploader can submit a dump to the bound case but
cannot list customers, cases, or existing dumps.

## Target primary flows

### Operator imports a received file

1. Select or create the customer.
2. Select or create the case.
3. Choose **Import dump** and select a local file.
4. DumpLedger allocates the dump ID and streams the file into staging.
5. DumpLedger computes SHA-256, seals and promotes the original, validates the
   minidump, classifies memory coverage, and publishes the record.
6. The case page shows the accepted dump or a visible rejection reason.

### Customer uploads files

1. The operator selects **Create upload link** on a case, choosing how many
   dumps the link accepts (1–16).
2. DumpLedger creates a grant with an expiry, a maximum byte count per dump,
   and that many upload slots.
3. The customer opens the link and streams their dumps one request per file,
   strictly sequentially; the page reports per-file outcomes and partial
   success is normal.
4. Beginning an upload consumes one slot, even if the stream fails or aborts.
   A retry requires an explicit new grant; this avoids one token silently
   creating unbounded dump records.
5. The case page updates as each dump moves through `receiving`, `sealed`,
   `quarantined`, and either `available` or `rejected`.

### Analyst downloads a dump

1. The analyst opens an `available` dump record.
2. DumpLedger authorizes the current account and writes an audit event.
3. The response is streamed from the vault. The original filename is supplied
   as download metadata, never interpreted as a filesystem path.

### Operator purges a dump

1. The interface displays the dump ID, customer, case, hash, byte size, and the
   effect on backups.
2. The operator confirms the purge.
3. DumpLedger first disables download and enters `deleting`.
4. DumpLedger removes the vault object and commits `deleted`.
5. A tombstone retains the association, hash and prior size when known, purge
   time, actor, and reason.

## Target web interface

The first release contains only these pages:

1. **Cases** — searchable by case ID, customer, status, dump ID, or hash.
2. **Case detail** — notes, external issue link, dumps, and upload grants.
3. **Dump detail** — lifecycle, coverage, exception metadata, hash, retention,
   download, and purge.
4. **Customers** — customer identity and related cases.
5. **Operations** — vault health, remaining disk, failed intake, and backups.

The case detail page is the home screen for an investigation. A separate
general-purpose project board is deliberately absent.

### Theming

The interface ships two palettes over one token set
(`frontend/src/styles/tokens.css`): the dark "evidence vault" identity it
launched with, and a light theme for bright desktops. Every colour the
interface paints resolves through a token, so switching themes is one
attribute on the document root (`data-theme="light" | "dark"`) and nothing
else changes.

- The header carries a `Theme` control with three preferences: **System** (the
  default, following `prefers-color-scheme` and re-resolving live when the OS
  flips), **Light**, and **Dark**. Operator and public chrome both carry it.
- An explicit choice is stored in `localStorage` under `dump-ledger.theme`;
  picking System clears the key so the OS decides again. Blocked storage
  degrades to the in-memory choice for that session.
- `frontend/src/shared/theme.ts` resolves and applies the theme before React's
  first render (called from `main.tsx`), and keeps the `theme-color` meta in
  step. It is part of the module graph rather than an inline snippet in the
  HTML shell because the production CSP admits same-origin scripts only
  (`docs/security-model.md`).
- Filled shapes (primary buttons, the copy-confirmation chip, the health-ok
  badge) paint with `*-solid` tokens that keep a fixed dark ink in both
  palettes; text, icons, and borders paint with the matching ink token. A new
  colour that bypasses the tokens is the one way to break a theme.

## Case and dump states

Case status:

```text
new -> investigating
investigating -> waiting-for-customer | resolved
waiting-for-customer -> investigating | resolved
resolved -> investigating | closed
closed -> investigating
```

Every transition is explicit and same-state transitions are illegal. Closing a
case atomically revokes its issued upload grants and prevents new grants or
uploads from beginning until the case resumes as `investigating`. Uploads that
already consumed a grant may finish. Dump events never change case status
implicitly. Closing does not purge or disable existing dumps; download and
retention policy remain authoritative.

Dump lifecycle:

```text
absent
  -> receiving
  -> sealed
  -> quarantined
  -> available
  -> deleting
  -> deleted

receiving   -> rejected       (transfer failed)
quarantined -> rejected       (validation failed)
rejected    -> deleting -> deleted
```

`sealed` is the crash-recovery phase between a completed upload and a durable
vault/ledger agreement. It is never downloadable.

`deleting` disables new downloads before filesystem removal. Startup recovery
finishes deletion if the process stops between those operations.

## Functional requirements

- **F1:** Every dump has exactly one immutable case association.
- **F2:** Each case has exactly one customer.
- **F3:** Each upload grant is bound to one case and can begin at most as
  many uploads as its issued slot count (1–16).
- **F4:** Input is streamed; memory consumption is bounded independently of
  dump size.
- **F5:** SHA-256 is computed over the original bytes while receiving them.
- **F6:** Only structurally valid, promoted dumps are downloadable.
- **F7:** Classification retains raw minidump flags and observed stream/range
  facts in addition to the derived coverage label.
- **F8:** Purge removes bytes but retains a minimal audit tombstone.
- **F9:** Operators can export a case manifest without opening SQLite.
- **F10:** Startup recovery resolves interrupted intake without publishing an
  incomplete dump.

## Non-functional requirements

- One Node.js process plus one data directory; release packaging may bundle the
  pinned Node.js 24 runtime but is not implemented yet.
- No separate frontend process, database server, Java runtime, or container
  runtime is required. Node.js is a production runtime dependency.
- Bounded-memory uploads, initially with a configurable concurrency limit.
- All identifiers used in paths are server-generated and path-safe.
- Database transactions remain short; dump bytes never pass through SQLite.
- Supported deployment starts with one active DumpLedger process. Multi-node
  writers are outside the first release.

## Explicit non-goals for the first release

- Email ingestion, chat, SLAs, kanban boards, and knowledge-base publishing.
- Automatic crash diagnosis or symbol-server management.
- Executing debuggers or customer-supplied binaries.
- Cross-customer content deduplication.
- Multi-node high availability.
- Inferring customer identity from dump contents.
- Treating a header flag as proof of complete address-space capture.
