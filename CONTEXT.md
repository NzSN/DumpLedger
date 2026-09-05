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

**Upload grant**:
A one-time, case-bound authorization to begin one dump upload. Closing a case
revokes every issued grant for that case.
_Avoid_: Reusable upload link
