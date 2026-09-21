# HTTP API reference

DumpLedger exposes a REST-style API for customers, cases, dump intake,
retention, symbols, and instance transfers. This document describes the
implemented HTTP surface in one place. It is intended for browser clients,
scripts, and debugger integrations.

The API is implemented by [Fastify routes](../src/http/routes/), with shared
[request and response contracts](../packages/http-contracts/src/index.ts).
There is no OpenAPI/Swagger document or generated API explorer. When changing
a route or contract, update this reference alongside it.

## Contents

- [Conventions](#conventions)
- [Authentication](#authentication)
- [Endpoint inventory](#endpoint-inventory)
- [Sessions](#sessions)
- [Customers and dashboard](#customers-and-dashboard)
- [Cases](#cases)
- [Upload grants](#upload-grants)
- [Dump uploads](#dump-uploads)
- [Dump detail, download, and retention](#dump-detail-download-and-retention)
- [Symbols](#symbols)
- [Operations and transfers](#operations-and-transfers)
- [Health and browser routes](#health-and-browser-routes)
- [Errors and retry behavior](#errors-and-retry-behavior)
- [Example client flow](#example-client-flow)

## Conventions

The main listener defaults to `http://127.0.0.1:4080`. Use the deployment's
HTTPS origin when accessing a remote instance. Most endpoints start with
`/api/v1`; `/health` and the debugger symbol store are exceptions.

- Send JSON bodies as `Content-Type: application/json`. JSON responses use
  `application/json; charset=utf-8`.
- Dump and symbol uploads use raw `application/octet-stream`, one file per
  request. Do not wrap file bytes in JSON, multipart, or base64.
- IDs are opaque, server-issued strings. Substitute and URL-encode path
  parameters such as `:caseId`; never infer an ID from a filename.
- Byte counts (`maxBytes`, `byteSize`) are **decimal strings** on the wire,
  such as `"1073741824"`. Counts, durations, and slot quotas are JSON numbers.
- Timestamps are canonical UTC ISO strings, such as
  `"2026-09-21T08:00:00.000Z"`. SHA-256 values are lowercase hexadecimal.
- `null` means an explicitly unavailable value; optional fields may be absent.
  Shapes below use `?` for optional fields, `[]` for arrays, and `|` for
  alternatives. They describe JSON, not the internal `bigint` types.
- Shared JSON request decoders reject unknown fields, duplicate keys, wrong
  types, and invalid values. Ordinary buffered request bodies have a 16 KiB
  server limit. Raw upload streams use their own byte limits.
- API responses and dump/export downloads use `Cache-Control: no-store`.
  Successful debugger symbol downloads and static assets use immutable caching.
- Unless specified otherwise, successful reads and mutations return `200`.
  `201` returns JSON; `204` has no response body.

Case workflow and dump lifecycle are independent. Closing a case revokes its
issued upload grants; it does not delete its dumps. See [CONTEXT.md](../CONTEXT.md)
for the domain vocabulary.

## Authentication

The inventory below uses these access labels:

| Label | Required evidence |
|---|---|
| Public | No operator session |
| Session | Valid `dump_ledger_session` cookie |
| Mutation | Session cookie plus `X-CSRF-Token` from the session response |
| Grant | `X-Upload-Grant: <secret>`; no operator session or CSRF token |
| Symbol ingest | Mutation authentication, or the dedicated CI bearer token |

Operator login sets an `HttpOnly; SameSite=Strict; Path=/` cookie, with `Secure`
in HTTPS mode. Sessions expire after eight hours by default, live in process
memory, and do not survive a restart. Preserve the cookie and keep the returned
CSRF token available for mutations. `GET /api/v1/session` can retrieve the token
for an existing session.

Mutation requests also validate `Origin` when present and reject
`Sec-Fetch-Site: cross-site`. A command-line client can omit those browser
headers but must still send the cookie and CSRF token. Missing/expired sessions
produce `401`; failed CSRF/origin checks produce `403` without logging out.

Only `POST /api/v1/symbols` accepts `Authorization: Bearer <token>`. The operator
configures its SHA-256 digest through `DUMP_LEDGER_INGEST_TOKEN_HASH`. If any
`Authorization` header is supplied on that endpoint, bearer authentication
takes precedence: an invalid token returns `401` even if a valid session cookie
is also present. Successful bearer requests do not require CSRF or Origin
evidence. This token cannot list, purge, export, or administer the ledger.

See [security-model.md](security-model.md) for transport and deployment controls.

## Endpoint inventory

| Method | Path | Access | Success | Purpose |
|---|---|---|---|---|
| GET | `/api/v1/session` | Public | 200 | Inspect session |
| POST | `/api/v1/session` | Public | 200 | Log in |
| DELETE | `/api/v1/session` | Mutation | 204 | Log out |
| GET | `/api/v1/dashboard` | Session | 200 | Counts and summaries |
| POST | `/api/v1/customers` | Mutation | 201 | Create customer |
| GET | `/api/v1/customers/:customerId` | Session | 200 | Customer and cases |
| POST | `/api/v1/customers/:customerId/cases` | Mutation | 201 | Create case |
| GET | `/api/v1/cases` | Session | 200 | Search/page through cases |
| GET | `/api/v1/cases/:caseId` | Session | 200 | Case detail |
| POST | `/api/v1/cases/:caseId/transitions` | Mutation | 200 | Change case workflow |
| GET | `/api/v1/cases/:caseId/manifest` | Session | 200 | Case metadata manifest |
| POST | `/api/v1/cases/:caseId/grants` | Mutation | 201 | Issue upload grant |
| POST | `/api/v1/grants/:grantId/revoke` | Mutation | 200 | Revoke grant |
| GET | `/api/v1/uploads/quota` | Grant | 200 | Read remaining quota |
| POST | `/api/v1/uploads` | Grant | 201 / 202 | Stream a dump |
| GET | `/api/v1/dumps/:dumpId` | Session | 200 | Dump detail |
| GET | `/api/v1/dumps/:dumpId/content` | Session | 200 | Stream dump bytes |
| PUT | `/api/v1/dumps/:dumpId/retention` | Mutation | 200 | Schedule purge |
| GET | `/api/v1/symbols` | Session | 200 | List PDB/image artifacts |
| POST | `/api/v1/symbols` | Symbol ingest | 201 | Stream PDB/EXE/DLL |
| DELETE | `/api/v1/symbols/:artifactId` | Mutation | 204 | Purge symbol artifact |
| GET | `/symbols/:name/:id/:file` | Public | 200 | Debugger artifact lookup |
| GET | `/api/v1/operations` | Session | 200 | Integrity and job summary |
| POST | `/api/v1/operations/exports` | Mutation | 201 | Start export |
| GET | `/api/v1/operations/exports` | Session | 200 | List export jobs |
| GET | `/api/v1/operations/exports/:id/file` | Session | 200 | Download sealed bundle |
| DELETE | `/api/v1/operations/exports/:id` | Mutation | 200 | Delete export bundle |
| POST | `/api/v1/operations/imports` | Mutation | 201 | Import server-local bundle |
| GET | `/api/v1/operations/imports/:id` | Session | 200 | Read import outcome |
| GET | `/health` | Public | 200 | Process liveness |

There are no general `GET /api/v1/customers` or `GET /api/v1/dumps` collection
endpoints. Use the dashboard/customer/case responses to discover those records.
There is no direct dump-delete HTTP endpoint; retention drives purge.

## Sessions

`POST /api/v1/session` accepts `{ "password": "..." }` (1–1024 characters).
On success it sets the session cookie and returns:

```json
{
  "authenticated": true,
  "csrfToken": "<opaque-token>",
  "expiresAt": "2026-09-21T16:00:00.000Z"
}
```

`GET /api/v1/session` returns that shape for an authenticated caller, or
`{ "authenticated": false }` with `200` otherwise. `DELETE /api/v1/session`
takes no body, invalidates the session, clears its cookie, and returns `204`.
Incorrect passwords return `401 unauthenticated`; login attempts are limited
to ten per client IP per five-minute window by default.

Source: [auth routes](../src/http/routes/auth-routes.ts),
[auth contracts](../packages/http-contracts/src/auth.ts).

## Customers and dashboard

`POST /api/v1/customers` accepts `{ "displayName": "Example customer" }`.
The name must be nonempty and at most 200 characters. It returns `201`:

```json
{ "customer": { "customerId": "<id>", "displayName": "Example customer" } }
```

`GET /api/v1/customers/:customerId` returns:

```text
{
  customer: { customerId, displayName, createdAt },
  cases: CaseSummary[]
}
CaseSummary = { caseId, customerId, title, status, createdAt }
```

The cases array contains at most 200 entries; it has no continuation cursor.
A missing customer returns `404 not_found`.

`POST /api/v1/customers/:customerId/cases` accepts
`{ "title": "Renderer crash" }` (nonempty, at most 300 characters), and returns
`201` with a bare `CaseSummary` whose status is `new`.

`GET /api/v1/dashboard` returns:

```text
{
  counts: { customers, activeCases, availableDumps, processingDumps },
  customers: [{ customerId, displayName }],
  recentCases: CaseSummary[]
}
```

Counts are numbers over the ledger. Active cases exclude `resolved` and
`closed`; processing dumps are `receiving`, `sealed`, `quarantined`, or
`deleting`. Customer summaries are limited to 100; case summaries to 20.

Source: [customer routes](../src/http/routes/customer-routes.ts),
[customer contracts](../packages/http-contracts/src/customers.ts).

## Cases

### Search and detail

`GET /api/v1/cases?query=<text>&cursor=<opaque-cursor>` returns
`{ cases: CaseSummary[], nextCursor?: string }`, at most 200 cases per page.
Both query parameters are optional and may appear only once. `query` is at
most 200 characters; `cursor` is at most 256 non-whitespace characters.
Search is a case-insensitive substring match over case ID, title, customer ID,
and customer display name. Results are ordered by case ID. Follow the returned
cursor with the same query; an absent `nextCursor` means the end. Pagination
does not pin a snapshot across requests.

`GET /api/v1/cases/:caseId` returns the `CaseSummary` fields plus:

```text
{
  customer: { customerId, displayName },
  allowedActions: CaseAction[],
  grants: [{ grantId, state, createdAt, expiresAt, maxBytes, maxUploads, uploadsUsed }],
  dumps: [{ dumpId, phase, originalName, byteSize: string | null, receivedAt }],
  missingSymbols: [{ debugFile, debugId, dumpIds: string[] }],
  activity: [{ occurredAt, action, outcome?: string }]
}
```

Grants, dumps, and activity are each limited to 200 entries. Activity is newest
first. Missing-symbol reporting groups PDB debug identities across the case's
available dumps, excluding modules identified as Windows system modules; it
is not a list of missing EXE/DLL artifacts. The response decoder accepts at
most 4096 missing identities and 4096 dump IDs per identity; the server's
aggregation does not itself truncate those lists.

### Case workflow transitions

`POST /api/v1/cases/:caseId/transitions` accepts one exact action name:

| `action` | Allowed current status | Resulting status |
|---|---|---|
| `StartInvestigation` | `new` | `investigating` |
| `WaitForCustomer` | `investigating` | `waiting-for-customer` |
| `ResumeInvestigation` | `waiting-for-customer`, `resolved`, `closed` | `investigating` |
| `ResolveCase` | `investigating`, `waiting-for-customer` | `resolved` |
| `CloseCase` | `resolved` | `closed` |

Example body: `{ "action": "StartInvestigation" }`. The response is:

```text
{
  caseId, action, status, occurredAt,
  revokedGrants?: { count: number, grantIds: string[] }
}
```

Closing includes the revoked-grant summary. The engine rechecks the current
state even if the client previously saw the action in `allowedActions`.
An illegal transition returns `409 invalid_transition`; a missing case returns
`404 not_found`. Resuming never restores revoked grants.

### Case manifest

`GET /api/v1/cases/:caseId/manifest` returns JSON metadata, without dump bytes:

```text
{
  schema: "dump-ledger.case-manifest/v1",
  case: CaseSummary,
  customer: { customerId, displayName, createdAt },
  grants: GrantRecord[],
  dumps: DumpProjection[],
  auditEvents: [{ eventId, occurredAt, action, customerId, caseId, dumpId, detail }]
}
```

Manifest grant records have the [grant fields](#upload-grants) plus
`consumedByDumpId` (string or null, the first consuming dump). Dump projections
contain `dumpId`, `caseId`, `phase`, `blobState`, `originalName`, `byteSize`,
`sha256`, `validation`, `coverage`, `downloadable`, `inspectionError`,
`inspectionFacts`, `receivedAt`, `availableAt`, `purgeAt`, and `purgedAt`.
`blobState` is `none`, `staging`, or `vault`; inspection facts are an object or
null. Other nullable fields have the same meanings as in dump detail below.
Audit associations may be null, and `detail` is an action-specific object.

This endpoint exposes the full case projection rather than the bounded detail
view. It contains no upload secret, and is not an importable transfer bundle.

Source: [case routes](../src/http/routes/case-routes.ts),
[case contracts](../packages/http-contracts/src/cases.ts),
[manifest construction](../src/http/application.ts).

## Upload grants

`POST /api/v1/cases/:caseId/grants` accepts:

```json
{ "validForHours": 24, "maxBytes": "1073741824", "maxUploads": 3 }
```

`validForHours` is an integer from 1 through 8784; `maxBytes` is a positive
canonical decimal string; optional `maxUploads` is an integer from 1 through
16 and defaults to 1. Expiry uses the server clock. Closed cases cannot receive
new grants (`409 invalid_transition`). The `201` response is:

```text
{
  grant: GrantRecord,
  uploadPath: "/upload#grant=<secret>"
}
GrantRecord = {
  grantId, caseId, state, createdAt, expiresAt,
  maxBytes: string, maxUploads: number, uploadsUsed: number
}
```

Grant states are `issued`, `consumed`, `revoked`, and `expired`. The creation
response has state `issued`. Resolve `uploadPath` against the service origin
to share it. The secret is returned only at issuance; keep it out of URL query
strings and paths. Browser URL fragments are not sent to the server; the
uploader extracts the secret and supplies `X-Upload-Grant`.

`POST /api/v1/grants/:grantId/revoke` takes no body and returns
`{ grant: GrantRecord }` with state `revoked`.

A grant authorizes starting uploads, not downloading dumps. Each begun upload
consumes one slot, including failed or oversized attempts; slots are not
refunded. A grant becomes `consumed` when all slots have been used. Closing its
case revokes any still-issued grant.

Source: [grant routes](../src/http/routes/grant-routes.ts),
[grant contracts](../packages/http-contracts/src/grants.ts).

## Dump uploads

### Query quota

`GET /api/v1/uploads/quota` requires `X-Upload-Grant` and returns:

```json
{ "maxUploads": 3, "uploadsUsed": 1, "maxBytes": "1073741824", "expiresAt": "2026-09-22T08:00:00.000Z" }
```

Remaining slots are `maxUploads - uploadsUsed`. Issued and consumed grants can
return quota; unknown, revoked, or expired grants return
`404 grant_unavailable`. A quota read does not reserve a slot.

### Send a dump

`POST /api/v1/uploads` takes the file stream with these headers:

```http
Content-Type: application/octet-stream
X-Upload-Grant: <secret>
X-Dump-Filename-Base64url: <unpadded-base64url-of-UTF-8-basename>
```

`Content-Length` is optional. The filename header is metadata, never a storage
path. Missing or invalid dump filenames fall back to `upload.dmp`. The grant
secret must be 16–256 base64url characters. Decoded filenames are bounded to
1024 characters and exclude path separators and control characters.

`201` means the stream was sealed and returns:

```text
{ dumpId, phase: "sealed" | "available" | "rejected", byteSize: string, sha256 }
```

Check `phase`: `201` alone does not mean the dump passed inspection. When
post-processing throws after sealing, the endpoint instead returns `202`:

```text
{ dumpId, byteSize: string, sha256, processing: "retry-queued" | "recovery-required" }
```

The bytes have already been received in this case; do not resend them as a
retry. An operator can inspect the dump-detail endpoint. There is no public
grant-authenticated dump-status endpoint.

Admission defaults to two concurrent dump uploads. Admission refusal is
`503 upload_busy` with `Retry-After: 5`, before consuming a grant slot.
Quota queries and upload attempts share a default limit of 30 requests per
client IP per minute (`429`, `Retry-After: 60`). Exhausted grants can return
`404 grant_slots_exhausted`; invalid grants return `404 grant_unavailable`.
Byte-limit failures return `413 upload_too_large`.

Dump and symbol streams default to a 60-second idle timeout and one-hour total
timeout, configurable through `DUMP_LEDGER_UPLOAD_IDLE_TIMEOUT_MS` and
`DUMP_LEDGER_UPLOAD_TOTAL_TIMEOUT_MS`. Timeout destroys the socket, so a client
may receive a connection error instead of JSON. After an uncertain dump-upload
outcome, check quota and operator-visible records before starting another
upload; repeating a request is not an idempotent retry.

Source: [upload routes](../src/http/routes/upload-routes.ts),
[upload contracts](../packages/http-contracts/src/uploads.ts).

## Dump detail, download, and retention

`GET /api/v1/dumps/:dumpId` returns:

```text
{
  dumpId, case: { caseId, title }, phase, originalName,
  byteSize: string | null, sha256: string | null,
  validation, coverage: string | null, downloadable: boolean,
  receivedAt, availableAt: string | null, purgeAt: string | null,
  purgedAt: string | null, inspectionError: string | null,
  symbolCoverage: [{
    name: string | null, debugFile: string | null, debugId: string | null,
    status: "present" | "missing" | "unidentified",
    artifactId: string | null, system: boolean
  }],
  activity: [{ occurredAt, action, outcome?: string }]
}
```

| Field | Values / meaning |
|---|---|
| `phase` | `receiving`, `sealed`, `quarantined`, `available`, `rejected`, `deleting`, `deleted` |
| `validation` | `not-checked`, `valid`, `invalid`, `transfer-failed` |
| `coverage` | `partial`, `full-memory-declared`, `unknown`, or null before classification |
| `downloadable` | Whether the lifecycle permits a download |
| `purgeAt` | Assigned purge deadline, or null when none is assigned |
| `symbolCoverage` | PDB availability per inspected module; the response decoder accepts at most 4096 entries |
| `activity` | At most 200 events, newest first |

`full-memory-declared` describes a minidump declaration, not proof that all
process memory was captured. Nullable byte/hash/timestamp fields reflect the
current lifecycle state. `inspectionError` is limited to 2000 characters.
The `system` flag identifies module paths under Windows System32, SysWOW64,
or WinSxS; it is a display hint, independent of the artifact's presence here.

`GET /api/v1/dumps/:dumpId/content` streams `application/octet-stream` with
`Content-Length` and `Content-Disposition: attachment; filename="<dumpId>.dmp"`.
Only available, downloadable dumps with accessible vault bytes are served;
an unavailable download returns `404 not_found`.

`PUT /api/v1/dumps/:dumpId/retention` accepts `{ "days": 30 }`, an integer
from 1 through 36500. It returns
`{ dump: { dumpId, purgeAt } }`, where the deadline is computed from the server
clock. This schedules deletion; the retention job performs purge later.
Invalid lifecycle states return `409 invalid_transition`.

Source: [dump routes](../src/http/routes/dump-routes.ts),
[dump contracts](../packages/http-contracts/src/dumps.ts).

## Symbols

### List and ingest

`GET /api/v1/symbols` returns `{ symbols: SymbolRecord[] }`. Each record has:

```text
{
  artifactId, kind: "pdb" | "exe",
  debugFile: string | null, debugId: string | null,
  codeFile: string | null, codeId: string | null,
  byteSize: string, sha256,
  product?: string, version?: string, arch?: string, ingestedAt
}
```

PDB records use `debugFile`/`debugId` and null code fields; EXE/DLL records use
`codeFile`/`codeId` and null debug fields. There is no pagination parameter.
The shared response decoder accepts at most 200 symbols; the current server
list implementation does not itself truncate the store to that bound.

`POST /api/v1/symbols` takes raw bytes with:

```http
Content-Type: application/octet-stream
X-Symbol-Filename-Base64url: <unpadded-base64url-of-UTF-8-basename>
```

Supply either operator mutation credentials or the ingest bearer token.
The filename header is required; unlike dump uploads, invalid filenames
return `400 invalid_request`. `.pdb` selects `pdb`; `.exe` and `.dll` select
`exe`, case-insensitively. Other suffixes return `409 symbol_kind_unsupported`.
The per-file limit is 8 GiB (8589934592 bytes), enforced while streaming as well
as against a supplied content length.

Optional headers are `X-Symbol-Product`, `X-Symbol-Version` (nonempty, at most
200 characters each), and `X-Symbol-Arch` (nonempty, at most 64 characters).
Identity is read from the staged file: PDB GUID/age or PE timestamp/image size.
An unreadable identity returns `422 symbol_identity_unreadable`; oversized
files return `413 symbol_too_large`.

The `201` response contains `artifactId`, `kind`, all four nullable identity
fields, `byteSize`, `sha256`, and `deduplicated` (boolean). Re-ingesting an
existing identity returns its existing artifact ID with `deduplicated: true`;
it does not replace stored bytes or annotations. On that path the response's
byte size and hash describe the submitted stream, so read the list record for
the stored artifact's metadata.

`DELETE /api/v1/symbols/:artifactId` takes no body and returns `204`, or `404`
for an unknown artifact. Purge removes that symbol artifact independently of
dump retention; references from dumps do not block it.

### Debugger lookup

`GET /symbols/:name/:id/:file` is an unauthenticated, read-only symbol-store
endpoint outside `/api/v1`. PDB lookups use debug filename and GUID/age ID;
EXE/DLL lookups use code filename and PE image ID. `file` must exactly repeat
`name`. Names are basenames of at most 255 code points, without separators,
control characters, `..`, or leading/trailing dots. IDs are 2–64 hexadecimal
characters and are matched case-insensitively.

Success streams `application/octet-stream` with `Content-Length` and
`Cache-Control: public, max-age=31536000, immutable`. Malformed paths and unknown
identities both return `404 not_found`.

For example, a debugger may use:

```text
.sympath SRV*C:\symcache*https://<host>/symbols
```

The main listener always registers the symbol-store route. Setting
`DUMP_LEDGER_SYMBOLS_PORT` enables a separate listener with only that lookup
route; it has no operator API, health route, or directory listing. It defaults
to loopback HTTP. A non-loopback bind requires the configured TLS certificate
and key. See [symbols-design.md](symbols-design.md) for identities and debugger
setup.

Source: [symbol administration](../src/http/routes/symbol-admin-routes.ts),
[symbol lookup](../src/http/routes/symbol-routes.ts),
[symbol contracts](../packages/http-contracts/src/symbols.ts).

## Operations and transfers

### Operations summary

`GET /api/v1/operations` returns:

```text
{
  integrity: { status: "ok" | "degraded", errorCount: number, errors: string[] },
  uploads: { active: number, capacity: number },
  postProcessing: { pending: number, exhausted: number, totalRetries: number },
  runtimeJobs: [{ name, running: boolean, runs: number, failures: number }]
}
```

Integrity errors are limited to 50 entries of at most 500 characters each;
`errorCount` counts the returned, bounded errors. A degraded result still uses
HTTP `200`; inspect the payload. Export/import status is obtained separately.

### Export

`POST /api/v1/operations/exports` accepts no body, `{}`, or
`{ "includeSymbols": true }` (default false). It returns `201 { exportId }`
after starting the job; poll `GET /api/v1/operations/exports` for completion.
The flag includes relevant PDB artifacts; the current transfer format does
not export EXE/DLL artifacts.

The list response is:

```text
{ exports: [{
  exportId, status: "running" | "sealed" | "failed", createdAt,
  byteSize: string | null, error: string | null
}] }
```

It returns at most the most recent 200 entries, ordered oldest first within
that selection. `GET /api/v1/operations/exports/:id/file` requires a `sealed`
job and streams `application/x-tar` with a content length and attachment name
`dump-ledger-export-<exportId>.tar`. Unknown IDs return `404`; a job that is
not sealed returns `409 invalid_transition`.

`DELETE /api/v1/operations/exports/:id` takes no body and returns
`{ "deleted": true }`. It removes the export bundle, not the source ledger or
dump artifacts. A running export cannot be deleted.

### Import

`POST /api/v1/operations/imports` accepts:

```json
{ "path": "/srv/dump-ledger/incoming/bundle.tar" }
```

This is a **path on the server**, not a local client path or an HTTP file upload.
The path is nonempty, at most 1024 characters, resolves to an existing regular
file, ends in `.tar`, and must not itself be a symbolic link. Invalid paths
return `400`; missing files return `404`.

The response is `201 { importId }`. Import currently performs synchronous
verification and processing before returning, blocking the server event loop
for that work. Do not interpret `201` as successful restoration: a bundle that
passes path checks but fails verification still creates a failed job. Read
`GET /api/v1/operations/imports/:id`:

```text
{
  importId, status: "running" | "finished" | "failed",
  verified: number, imported: number, rejected: number, skipped: number,
  error: string | null
}
```

Imports require an empty destination ledger; they do not merge arbitrary live
instances. Grant-key fingerprint policy controls imported grants, and dump
bytes are verified and inspected before becoming available. See
[import-export-design.md](import-export-design.md) for the bundle format and
restoration rules.

One export or import job may run at a time; attempting another while occupied
returns `409 invalid_transition`. Import-job records are process-local.
Sealed export bundles are rediscovered from disk at startup. Transfer routes
are enabled by the normal application entry point; an embedded server without
a transfer manager does not register them.

Source: [transfer routes](../src/http/routes/transfer-routes.ts),
[transfer contracts](../packages/http-contracts/src/transfer.ts),
[operations contracts](../packages/http-contracts/src/operations.ts).

## Health and browser routes

`GET /health` is public and returns `200 { "status": "ok" }`. It is a liveness
check, not a database/vault integrity check. Use the authenticated operations
endpoint for integrity information.

The following GET routes return the React HTML shell, not API JSON:
`/`, `/login`, `/upload`, `/customers`, `/customers/:customerId`, `/cases`,
`/cases/:caseId`, `/dumps`, `/dumps/:dumpId`, `/operations`, and `/symbols`.
Protected data still requires API authentication. `/assets/:file` serves the
built static assets with their content types and immutable caching.

Unknown API paths do not fall back to the React shell. Legacy paths such as
`/upload/:secret` and `/dumps/:dumpId/download` are not supported. The browser
page `/symbols` is distinct from the three-segment debugger lookup route.

Source: [server](../src/http/server.ts), [static serving](../src/http/static-web.ts).

## Errors and retry behavior

Handled application errors use this envelope:

```json
{
  "error": {
    "code": "invalid_transition",
    "message": "That action is not allowed from the current state.",
    "retryable": false
  }
}
```

| HTTP status | `error.code` | Meaning |
|---|---|---|
| 400 | `invalid_request` | Malformed or invalid request |
| 401 | `unauthenticated` | Missing/invalid session, password, or ingest token |
| 403 | `forbidden` | CSRF, Origin, or Fetch Metadata check failed |
| 404 | `not_found` | Resource or artifact not available |
| 404 | `grant_unavailable` | Unknown, expired, revoked, or unusable grant |
| 404 | `grant_slots_exhausted` | Grant has no remaining upload slots |
| 409 | `invalid_transition` | Current state does not allow the operation |
| 409 | `symbol_kind_unsupported` | Filename does not select a supported artifact kind |
| 413 | `upload_too_large` | Dump exceeds its grant's byte ceiling |
| 413 | `symbol_too_large` | Symbol exceeds the 8 GiB ceiling |
| 422 | `symbol_identity_unreadable` | PDB/PE identity could not be parsed |
| 429 | `rate_limited` | Request rate exceeded |
| 500 | `integrity_failure` | Internal integrity check failed |
| 500 | `internal_error` | Unexpected application failure |
| 503 | `upload_busy` | Dump upload admission is full |
| 503 | `storage_unavailable` | Storage/transfer temporarily unavailable |

Only `rate_limited`, `upload_busy`, and `storage_unavailable` set
`retryable: true`. Respect `Retry-After` when present (login: 300 seconds;
upload/quota rate limit: 60; upload admission: 5). Rate limits are process-local
and reset on restart. A retryable error does not guarantee that an upload slot
was unconsumed or that repeating a mutation is safe.

Transport failures, Fastify parser/body-limit errors, uncaught exceptions,
and unknown routes on the main listener can use framework responses rather
than this envelope. Clients should handle non-JSON and unexpected error shapes
as well as connection termination. Transfer-job `error` fields are separate
from this request-level envelope and are bounded to 2000 characters.

Source: [error mapping and guards](../src/http/contracts/json.ts),
[error contracts](../packages/http-contracts/src/errors.ts).

## Example client flow

This sequence shows the wire requests; placeholders are values from previous
responses. Use the deployment's HTTPS origin for remote calls.

1. `POST /api/v1/session` with `{ "password": "<operator-password>" }`.
   Retain `Set-Cookie` and the response's `csrfToken`.
2. `POST /api/v1/customers` with `{ "displayName": "Example customer" }`,
   the cookie, and `X-CSRF-Token`. Read `customer.customerId`.
3. `POST /api/v1/customers/<customerId>/cases` with
   `{ "title": "Renderer crash" }` and the same mutation credentials.
   Read `caseId` from the resulting case summary.
4. `POST /api/v1/cases/<caseId>/grants` with
   `{ "validForHours": 24, "maxBytes": "1073741824", "maxUploads": 2 }`.
   Read the secret from the returned `uploadPath` fragment.
5. `POST /api/v1/uploads` with the raw dump and `X-Upload-Grant`. For a
   filename `crash.dmp`, `X-Dump-Filename-Base64url` is `Y3Jhc2guZG1w`.
   This request needs neither the operator cookie nor CSRF token.
6. Check the returned `phase` or `processing` field. As the operator, use
   `GET /api/v1/dumps/<dumpId>` with the session cookie to inspect the result,
   and `/api/v1/dumps/<dumpId>/content` to download available bytes.
7. Use `/api/v1/cases/<caseId>/transitions` to record investigation progress,
   and `/api/v1/dumps/<dumpId>/retention` to assign a purge deadline separately.
