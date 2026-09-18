# Security model

## Security posture

A minidump is untrusted input and potentially high-impact customer data. Even a
small partial dump may contain credentials, tokens, source text, document
fragments, personal information, and cryptographic material. A full-memory
declared dump increases exposure but does not create a separate trust class:
all dumps receive the strongest baseline controls.

DumpLedger's security goal is to preserve confidentiality and association while
preventing incomplete or attacker-controlled input from becoming an executable
or downloadable trusted artifact.

## Current security implementation status

Implemented and tested in the current TypeScript 7 baseline are keyed grant
digests, one-time/expiring/case-bound grants, cryptographic IDs and session
tokens, CSRF checks, secure cookie options, restrictive response headers,
streamed byte limits, bounded concurrent-upload admission, bounded
process-local rate limits for login and grant verification, opaque vault paths,
no-follow/restrictive filesystem creation, bounded structural inspection,
download gating, audit rows, startup reconciliation, explicit retention
scheduling, two-phase deletion, and digest-only CI symbol-ingest tokens
("CI symbol-ingest tokens" below).

This is not yet an internet-deployment approval. DumpLedger does not terminate
TLS; a trusted reverse proxy and its network controls must be configured and
tested. Rate-limit state is process-local and resets on restart. Automatic
coverage-specific retention defaults, coordinated vault backup/restore and
tombstone replay, grant-key rotation, Windows packaging/ACL validation, and
real-dump plus fuzz-corpus parser testing are deferred. The encrypted-volume
requirement is an operator/deployment control, not application-level encryption
implemented by DumpLedger. The repository license also remains undecided.

## Protected assets

- Original dump bytes and derived metadata.
- Customer-to-case-to-dump associations.
- Upload-grant secrets and authenticated sessions.
- Audit history and deletion evidence.
- Vault encryption keys and backup credentials.
- Availability of disk space and the intake endpoint.

## Threat actors and failures

- An unauthenticated internet client guessing or replaying an upload URL.
- A customer attempting to view another customer's cases or dumps.
- A malicious upload containing malformed lengths, offsets, or extreme counts.
- Accidental operator association of a dump with the wrong case.
- Path traversal through a supplied filename.
- Disk exhaustion through oversized or concurrent uploads.
- Process, host, or power failure between SQLite and filesystem writes.
- An analyst workstation retaining an uncontrolled copy.
- A backup preserving bytes after the UI claims deletion.
- An internal user downloading more data than required.

## Trust zones

```text
untrusted browser and dump bytes
              |
           HTTPS
              v
HTTP shell and bounded intake
              |
      quarantined vault object
              |
      structural inspection only
              v
 authorized analyst download
```

The minidump parser remains inside the untrusted-data zone. Its output becomes
trusted metadata only after all referenced ranges and counts pass bounds and
overflow checks.

## Required controls

### Upload grants

- Generate at least 256 bits of cryptographically secure randomness.
- Put the secret only in the URL delivered to the customer; store a keyed or
  password-style hash, never the secret itself.
- Bind the grant to one case, one maximum size per dump, one expiry, and a
  bounded slot count (`maxUploads`, 1–16). Total ingress from one leaked link
  is bounded by slots × per-dump bytes, and a failed or aborted upload still
  consumes its slot.
- Consume each slot atomically when a dump ID is allocated; the grant is
  consumed exactly when its last slot is taken.
- Return the same external response for unknown, expired, and revoked secrets
  where practical. Deliberate exception: a valid-but-exhausted secret earns
  the distinct, non-retryable `grant_slots_exhausted` (batch upload design,
  decision 3) so honest batch uploaders learn their link is full rather than
  unusable.
- Never place the secret in normal request logs, analytics, or referrer output.
- Set `Referrer-Policy: no-referrer` on upload pages.

### Transport and browser interface

- Require modern HTTPS for every non-loopback deployment.
- Mark authenticated cookies `Secure`, `HttpOnly`, and `SameSite=Strict`.
- Protect state-changing operator requests against CSRF.
- Apply request-header, idle, and total-duration timeouts that still permit
  expected full-memory upload sizes.
- Rate-limit grant verification independently from bulk upload bandwidth.
- Do not load third-party scripts, fonts, analytics, or content on pages that
  contain a grant secret or dump metadata.

### Filesystem

- Require an encrypted local volume for `data/`, including staging and backups.
- Run as a dedicated operating-system identity.
- Restrict the data directory to that identity and a controlled backup reader.
- Create files without following symlinks and with restrictive permissions.
- Keep staging and vault on the same local filesystem for atomic promotion.
- Use opaque dump IDs for paths; retain the supplied filename only as escaped
  metadata.
- Never serve the vault directory as static web content.

### Parser

- Verify the minidump signature before walking its stream directory.
- Perform checked integer arithmetic for every offset, count, and size.
- Reject any referenced range outside the sealed file.
- Bound stream count, module count, thread count, string length, and derived
  metadata size independently of the upload limit.
- Parse through random-access reads; never allocate based only on an untrusted
  count.
- Do not execute debuggers, symbol extensions, binaries, scripts, or commands
  during intake.
- Fuzz the inspection interface with malformed and truncated files.

### Authorization and audit

- Uploaders can create data only through their bound grant and cannot list it.
- Analysts may download only `available` dumps for authorized cases.
- Purge and retention changes require operator permission and reauthentication
  when deployed beyond a single trusted operator.
- Record grant creation/revocation, upload start/seal/rejection, download,
  retention change, purge, authentication failure, and restore verification.
- Audit details contain identifiers and outcomes, not dump contents or secret
  tokens.

### CI symbol-ingest tokens

A release pipeline (CI) can register symbol artifacts without an interactive
operator session. The token is bearer-equivalent and deliberately narrow.

- **Disabled by default.** Token auth exists only while
  `DUMP_LEDGER_INGEST_TOKEN_HASH` carries the 64-lowercase-hex sha256 of the
  bearer token. Unset or empty disables the path entirely: a presented
  authorization is then a generic 401, never a fall-through to session
  cookies.
- **Ingest-only scope.** The token is consulted by exactly one route —
  `POST /api/v1/symbols`. It cannot list the store, purge an artifact, read
  symbol bytes, or reach any other route; those remain operator-session
  surfaces (list and purge reject a bearer token with the same 401 as an
  anonymous request).
- **Digest at rest.** Only the sha256 digest is configured; the token itself
  is generated with at least 256 bits of entropy
  (`npm run generate:ingest-token`), belongs in the CI secret store, and is
  never written to the ledger, logs, or audit details.
- **Pinned precedence.** When a request carries any `Authorization` header,
  only the bearer path is consulted: the header must be a `Bearer` credential
  whose sha256 matches the configured digest in constant time. A wrong token,
  a malformed header, or a disabled configuration is the same generic 401
  envelope the session guard uses — there is no silent cookie/CSRF fallback.
- **No cookie semantics.** Bearer requests skip CSRF and Origin checks because
  they carry no ambient browser authority; they must still ride TLS, and the
  token must not be placed in URLs or logs.
- **Attribution.** The seal audit event records the ingest channel —
  `ingestAuth: "token"` for a pipeline and `"operator"` for an interactive
  session (`null` for transfer-imported artifacts, which have no HTTP auth
  channel) — so token ingests are distinguishable from interactive ones.
- **Unchanged ingest discipline.** Kind-by-suffix, the mid-stream ceiling, the
  single-ingest guard, and identity parsed from bytes (never from uploader
  input) apply identically on both channels.
- **Rotation.** Generate a new token, replace the configured hash, and restart
  the process. There is no stateful revocation list; a replaced digest retires
  the old token immediately.

### Dedicated symbols listener

The symsrv read surface (`GET /symbols/<name>/<id>/<file>`) additionally runs
on its own optional listener so debugger traffic is split from the operator
surface (implemented 2026-09-18; design decision D1 is unchanged).

- **Disabled by default.** The listener exists only while
  `DUMP_LEDGER_SYMBOLS_PORT` carries a valid port
  (`DUMP_LEDGER_SYMBOLS_HOST` selects the bind address, default `0.0.0.0`).
  Unset or empty starts no second socket at all.
- **Unauthenticated read-only by design.** symsrv.dll cannot present
  credentials; the listener serves nothing but immutable symbol bytes and
  grammar-validated 404 misses. There is no session surface, no admin
  surface, and no directory listing — the ingest, list, and purge paths do
  not exist on this socket and answer the same uniform 404 as an unknown
  identity.
- **Plain HTTP by design.** symsrv.dll only trusts server certificates
  chaining to a trusted root on the analysis machine; a self-signed proxy
  cert made the shared HTTPS route friction for CDB. The dedicated listener
  is therefore plain HTTP, which is acceptable precisely because it
  authenticates nothing and serves public-to-the-LAN bytes: the threat model
  for this socket is disclosure of build identities (accepted by D1) and
  tampering on the wire, mitigated by symbol identity being content-keyed —
  a wrong-byte artifact cannot satisfy a GUID+age query for the right one,
  and debuggers hash-check downloaded PDBs against the debug directory.
  Keep the port on the analysis LAN; do not expose it untrusted networks,
  and front it with an IP allowlist where the LAN is not already trusted.
- **Availability isolation.** Debugger fetch patterns (many serial requests)
  cannot starve the operator API: the listener is a separate socket with its
  own connection pool, and it does no rate limiting, logging, or audit per
  fetch.

### Full-memory handling

- Display a customer warning before upload that process memory may contain
  secrets and personal data.
- Default full-memory-declared dumps to a shorter retention period than partial
  dumps, while allowing an explicit case override.
- Make coverage classification visible before every download.
- Do not use `MiniDumpWithFullMemoryInfo` as evidence that raw full memory was
  captured.

## Retention and deletion

Retention is a timestamp on each dump, derived from policy at acceptance.
Expiration disables new downloads before physical deletion begins.

Purge first commits a non-downloadable `deleting` phase, then removes bytes and
commits `deleted`. Recovery always finishes an interrupted deletion. The
resulting tombstone keeps only:

- dump, case, and customer identifiers;
- original SHA-256 and byte count;
- coverage and validation labels;
- received and purged timestamps;
- actor and reason.

The UI must state the backup deletion horizon. “Deleted” means absent from the
active vault; backup copies remain recoverable until their documented expiry.
Restore tooling must reapply tombstones so an old backup cannot silently
resurrect purged dumps.

## Deliberate exclusions

- No cross-customer deduplication. A digest is an integrity value, not a shared
  authorization handle.
- No public or permanent object URLs.
- No customer-identifying data in vault keys.
- No claim that encryption compensates for excessive retention or broad
  analyst access.
- No automatic upload of a dump to third-party analysis systems.

## Outstanding security acceptance gates

Before the first internet-facing deployment:

1. Test expired, revoked, replayed, malformed, and oversized grant requests.
2. Test mid-upload disconnect and process termination at every durable intake
   phase.
3. Fuzz header and stream-directory inspection.
4. Verify path traversal and symlink attacks cannot escape the data directory.
5. Verify an unavailable, rejected, expired, or deleted dump cannot be
   downloaded through any route.
6. Restore a backup and prove purge tombstones remain effective.
7. Inspect logs for secret URLs, customer filenames, and recovered memory data.
8. Document incident response and key rotation for the actual deployment.
