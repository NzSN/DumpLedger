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
scheduling, and two-phase deletion.

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
- Bind the grant to one case, one maximum size, one expiry, and one dump.
- Consume it atomically when a dump ID is allocated.
- Return the same external response for unknown, expired, revoked, and consumed
  secrets where practical.
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
