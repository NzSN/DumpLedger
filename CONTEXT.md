# DumpLedger

DumpLedger receives sensitive crash evidence for a customer support case while
keeping human investigation progress distinct from dump storage and retention.

## Language

**Case**:
An investigation record owned by exactly one customer and associated with its
upload grants, dumps, and audit history.
_Avoid_: Ticket, project

**Case workflow**:
The operator-controlled progress of a case through `new`, `investigating`,
`waiting-for-customer`, `resolved`, and `closed`.
_Avoid_: Case lifecycle

**New**:
A case whose investigation has not started.

**Investigating**:
A case under active analysis.

**Waiting for customer**:
A case whose investigation is waiting for customer-provided evidence or input.

**Resolved**:
A case with an established outcome that has not yet been administratively
closed.

**Closed**:
An administratively inactive case. It retains its dumps and may explicitly
resume as `investigating`.

**Resume investigation**:
An explicit return from `waiting-for-customer`, `resolved`, or `closed` to
`investigating`.
_Avoid_: Implicit reopen

**Dump lifecycle**:
The storage, validation, availability, and deletion state of one immutable dump
artifact; it is independent of case workflow.
_Avoid_: Case status

**Webhook subscription**:
An operator-registered push target (URL, optional action/case filters, signing
secret) that receives audit events as signed HTTP POSTs. It is operational
configuration, not ledger domain state.
_Avoid_: Listener, hook

**Delivery**:
One subscription's attempt chain for a single audit event: `pending`,
`delivered`, or `exhausted`. Deliveries are ordered and at-least-once per
subscription; an `exhausted` delivery means the event was skipped after all
retries and remains available through the audit event feed.
_Avoid_: Message, notification record

**Upload grant**:
A short-lived, case-bound authorization to begin dump uploads. Each grant is
issued with a slot count (`maxUploads`, 1–128); a one-slot grant is a one-time
grant. Closing a case revokes every issued grant for that case.
_Avoid_: Reusable upload link

**Grant slot**:
One unit of upload authorization on an upload grant. Beginning an upload
consumes exactly one slot, whether the stream seals, exceeds the byte ceiling,
or aborts.
_Avoid_: Upload credit, attempt

**Batch grant**:
An upload grant issued with more than one slot, delivered as a single share
link.
_Avoid_: Multi-link, shared grant

**Module**:
One loadable binary image identity (`code_file`/`code_id` plus
`debug_file`/`debug_id`), annotated with product, version, and architecture.
_Avoid_: Library, binary, package

**Symbol artifact**:
One immutable file (kind `pdb`) satisfying one module's debug identity, bytes
in the vault; re-ingesting the same identity is a no-op.
_Avoid_: Debug blob, symbol dump

**Symbol store**:
The symbol-artifact collection plus the symsrv-protocol read surface
(`GET /symbols/<debug_file>/<debug_id>/<debug_file>`).
_Avoid_: Symbol server, pdb folder

**Analyzer**:
An external machine consumer that reads the dump catalog and audit event
feed, downloads dump bytes and symbols, and records analysis reports back
against dumps. Authenticated by an analyzer token, never an operator session.
_Avoid_: Worker, plugin

**Analyzer token**:
A configured bearer credential (digest at rest) that authenticates an
analyzer on the catalog read routes and the analysis write-back route.
_Avoid_: API key, service account

**Analysis report**:
One immutable verdict record attached to a dump, produced by one named
analyzer at one version against one dump content hash; re-recording the same
identity is a no-op replay.
_Avoid_: Verdict blob, scan result
