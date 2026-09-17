------------------------------ MODULE DumpLedger ------------------------------
EXTENDS FiniteSets, Naturals, Sequences

\* Finite model slots. Production identifiers remain opaque strings; the
\* client-local adapter maps these integer slots to real branded identifiers.
Customers == 1..2
Cases     == 1..2
Tokens    == 1..2
Dumps     == 1..2
\* Debug identities modeled abstractly: each slot is one distinct
\* (debug_file, debug_id, kind) triple (docs/symbols-design.md).
Symbols   == 1..2

NoCase     == 0
NoDump     == 0
NoCoverage == "unclassified"

TokenStates      == {"unused", "issued", "consumed", "revoked", "expired"}
CaseStatuses     == {"new", "investigating", "waiting-for-customer",
                     "resolved", "closed"}
DumpPhases       == {"absent", "receiving", "sealed", "quarantined",
                     "available", "rejected", "deleting", "deleted"}
BlobStates       == {"none", "staging", "vault"}
ValidationStates == {"not-checked", "valid", "invalid", "transfer-failed"}
CoverageKinds    == {"partial", "full-memory-declared", "unknown"}

\* Every case has exactly one customer. Every token is minted for exactly one
\* case. Sequence indexing is the finite-slot representation used by traces.
\* @type: Seq(Int);
CaseCustomer == <<1, 2>>
\* @type: Seq(Int);
TokenCase    == <<1, 2>>
\* Upload slots per grant (docs/batch-upload-design.md): token 1 models a
\* one-time grant, token 2 a two-slot batch grant.
\* @type: Seq(Int);
TokenMaxUploads == <<1, 2>>

VARIABLES
  \* @type: Seq(Str);
  caseStatus,       \* case slot -> CaseStatuses
  \* @type: Seq(Str);
  tokenState,       \* token slot -> TokenStates
  \* @type: Seq(Int);
  dumpToken,        \* dump slot -> token slot or 0
  \* @type: Seq(Int);
  tokenUploads,     \* token slot -> upload slots consumed
  \* @type: Seq(Str);
  dumpPhase,        \* dump slot -> DumpPhases
  \* @type: Seq(Int);
  dumpCase,         \* dump slot -> case slot or 0; immutable once assigned
  \* @type: Seq(Str);
  blobState,        \* dump slot -> BlobStates
  \* @type: Set(Int);
  digestRecorded,   \* dump slots whose original SHA-256 is durably recorded
  \* @type: Seq(Str);
  validation,       \* dump slot -> ValidationStates
  \* @type: Seq(Str);
  coverage,         \* dump slot -> CoverageKinds or NoCoverage
  \* @type: Set(Int);
  downloadable,     \* dump slots currently authorized for download
  \* @type: Set(Int);
  symbolRegistered, \* symbol identity slots currently registered
  \* @type: Str;
  action_taken,     \* last non-stuttering transition, for traces
  \* @type: { case: Int, token: Int, dump: Int, kind: Str };
  parameters        \* complete inputs of the last transition

vars == <<caseStatus, tokenState, dumpToken, tokenUploads, dumpPhase, dumpCase, blobState,
          digestRecorded, validation, coverage, downloadable, symbolRegistered,
          action_taken, parameters>>

Init ==
  /\ caseStatus = <<"new", "new">>
  /\ tokenState = <<"unused", "unused">>
  /\ dumpToken = <<NoDump, NoDump>>
  /\ tokenUploads = <<0, 0>>
  /\ dumpPhase = <<"absent", "absent">>
  /\ dumpCase = <<NoCase, NoCase>>
  /\ blobState = <<"none", "none">>
  /\ digestRecorded = {}
  /\ validation = <<"not-checked", "not-checked">>
  /\ coverage = <<NoCoverage, NoCoverage>>
  /\ downloadable = {}
  /\ symbolRegistered = {}
  /\ action_taken = "Init"
  /\ parameters = [case |-> 0, token |-> 0, dump |-> 0,
                     kind |-> NoCoverage]

\* Case status is operator-controlled workflow metadata. Dump lifecycle actions
\* never change it implicitly.
StartInvestigation(c) ==
  /\ c \in Cases
  /\ caseStatus[c] = "new"
  /\ caseStatus' = [caseStatus EXCEPT ![c] = "investigating"]
  /\ action_taken' = "StartInvestigation"
  /\ parameters' = [case |-> c, token |-> 0, dump |-> 0,
                      kind |-> NoCoverage]
  /\ UNCHANGED <<tokenState, dumpToken, tokenUploads, dumpPhase, dumpCase, blobState,
                 digestRecorded, validation, coverage, downloadable, symbolRegistered>>

WaitForCustomer(c) ==
  /\ c \in Cases
  /\ caseStatus[c] = "investigating"
  /\ caseStatus' = [caseStatus EXCEPT ![c] = "waiting-for-customer"]
  /\ action_taken' = "WaitForCustomer"
  /\ parameters' = [case |-> c, token |-> 0, dump |-> 0,
                      kind |-> NoCoverage]
  /\ UNCHANGED <<tokenState, dumpToken, tokenUploads, dumpPhase, dumpCase, blobState,
                 digestRecorded, validation, coverage, downloadable, symbolRegistered>>

\* Waiting, resolved, and closed cases reopen explicitly. Reopening a closed
\* case does not restore grants revoked when it was closed.
ResumeInvestigation(c) ==
  /\ c \in Cases
  /\ caseStatus[c] \in {"waiting-for-customer", "resolved", "closed"}
  /\ caseStatus' = [caseStatus EXCEPT ![c] = "investigating"]
  /\ action_taken' = "ResumeInvestigation"
  /\ parameters' = [case |-> c, token |-> 0, dump |-> 0,
                      kind |-> NoCoverage]
  /\ UNCHANGED <<tokenState, dumpToken, tokenUploads, dumpPhase, dumpCase, blobState,
                 digestRecorded, validation, coverage, downloadable, symbolRegistered>>

ResolveCase(c) ==
  /\ c \in Cases
  /\ caseStatus[c] \in {"investigating", "waiting-for-customer"}
  /\ caseStatus' = [caseStatus EXCEPT ![c] = "resolved"]
  /\ action_taken' = "ResolveCase"
  /\ parameters' = [case |-> c, token |-> 0, dump |-> 0,
                      kind |-> NoCoverage]
  /\ UNCHANGED <<tokenState, dumpToken, tokenUploads, dumpPhase, dumpCase, blobState,
                 digestRecorded, validation, coverage, downloadable, symbolRegistered>>

\* Closing is administrative: dump bytes, downloadability, and retention are
\* unchanged. Every issued grant for the case is revoked atomically, while an
\* upload that already consumed its grant may finish normally.
CloseCase(c) ==
  /\ c \in Cases
  /\ caseStatus[c] = "resolved"
  /\ caseStatus' = [caseStatus EXCEPT ![c] = "closed"]
  \* Enumerate the fixed Tokens == 1..2 slots so the result remains Seq(Str)
  \* for both the model-interface compiler and Apalache's type checker.
  /\ tokenState' =
       [tokenState EXCEPT
          ![1] = IF TokenCase[1] = c /\ tokenState[1] = "issued"
                  THEN "revoked" ELSE tokenState[1],
          ![2] = IF TokenCase[2] = c /\ tokenState[2] = "issued"
                  THEN "revoked" ELSE tokenState[2]]
  /\ action_taken' = "CloseCase"
  /\ parameters' = [case |-> c, token |-> 0, dump |-> 0,
                      kind |-> NoCoverage]
  /\ UNCHANGED <<dumpToken, tokenUploads, dumpPhase, dumpCase, blobState, digestRecorded,
                 validation, coverage, downloadable, symbolRegistered>>

\* Mint a one-time upload grant for its statically modeled case.
IssueToken(t) ==
  /\ t \in Tokens
  /\ tokenState[t] = "unused"
  /\ caseStatus[TokenCase[t]] /= "closed"
  /\ tokenState' = [tokenState EXCEPT ![t] = "issued"]
  /\ action_taken' = "IssueToken"
  /\ parameters' = [case |-> 0, token |-> t, dump |-> 0,
                      kind |-> NoCoverage]
  /\ UNCHANGED <<caseStatus, dumpToken, tokenUploads, dumpPhase, dumpCase, blobState,
                 digestRecorded, validation, coverage, downloadable, symbolRegistered>>

RevokeToken(t) ==
  /\ t \in Tokens
  /\ tokenState[t] = "issued"
  /\ tokenState' = [tokenState EXCEPT ![t] = "revoked"]
  /\ action_taken' = "RevokeToken"
  /\ parameters' = [case |-> 0, token |-> t, dump |-> 0,
                      kind |-> NoCoverage]
  /\ UNCHANGED <<caseStatus, dumpToken, tokenUploads, dumpPhase, dumpCase, blobState,
                 digestRecorded, validation, coverage, downloadable, symbolRegistered>>

ExpireToken(t) ==
  /\ t \in Tokens
  /\ tokenState[t] = "issued"
  /\ tokenState' = [tokenState EXCEPT ![t] = "expired"]
  /\ action_taken' = "ExpireToken"
  /\ parameters' = [case |-> 0, token |-> t, dump |-> 0,
                      kind |-> NoCoverage]
  /\ UNCHANGED <<caseStatus, dumpToken, tokenUploads, dumpPhase, dumpCase, blobState,
                 digestRecorded, validation, coverage, downloadable, symbolRegistered>>

\* Allocation consumes one grant slot and fixes the dump-to-case association
\* before customer bytes are trusted. A dump slot never returns to "absent".
\* The grant stays issued until its last slot is taken (batch upload design).
BeginUpload(t, d) ==
  /\ t \in Tokens
  /\ d \in Dumps
  /\ tokenState[t] = "issued"
  /\ caseStatus[TokenCase[t]] /= "closed"
  /\ tokenUploads[t] < TokenMaxUploads[t]
  /\ dumpPhase[d] = "absent"
  /\ dumpCase[d] = NoCase
  /\ tokenUploads' = [tokenUploads EXCEPT ![t] = @ + 1]
  /\ tokenState' = [tokenState EXCEPT ![t] =
                     IF tokenUploads[t] + 1 >= TokenMaxUploads[t]
                     THEN "consumed" ELSE "issued"]
  /\ dumpToken' = [dumpToken EXCEPT ![d] = t]
  /\ dumpPhase' = [dumpPhase EXCEPT ![d] = "receiving"]
  /\ dumpCase' = [dumpCase EXCEPT ![d] = TokenCase[t]]
  /\ blobState' = [blobState EXCEPT ![d] = "staging"]
  /\ action_taken' = "BeginUpload"
  /\ parameters' = [case |-> 0, token |-> t, dump |-> d,
                      kind |-> NoCoverage]
  /\ UNCHANGED <<caseStatus, digestRecorded, validation, coverage,
                 downloadable, symbolRegistered>>

\* Sealing represents a complete, flushed staging file plus durable length and
\* digest metadata. Bytes are still quarantined from readers.
SealUpload(d) ==
  /\ d \in Dumps
  /\ dumpPhase[d] = "receiving"
  /\ blobState[d] = "staging"
  /\ dumpPhase' = [dumpPhase EXCEPT ![d] = "sealed"]
  /\ digestRecorded' = digestRecorded \cup {d}
  /\ action_taken' = "SealUpload"
  /\ parameters' = [case |-> 0, token |-> 0, dump |-> d,
                      kind |-> NoCoverage]
  /\ UNCHANGED <<caseStatus, tokenState, dumpToken, tokenUploads, dumpCase, blobState,
                 validation, coverage, downloadable, symbolRegistered>>

\* A failed stream consumes the grant and dump slot but publishes no bytes.
FailUpload(d) ==
  /\ d \in Dumps
  /\ dumpPhase[d] = "receiving"
  /\ dumpPhase' = [dumpPhase EXCEPT ![d] = "rejected"]
  /\ blobState' = [blobState EXCEPT ![d] = "none"]
  /\ validation' = [validation EXCEPT ![d] = "transfer-failed"]
  /\ action_taken' = "FailUpload"
  /\ parameters' = [case |-> 0, token |-> 0, dump |-> d,
                      kind |-> NoCoverage]
  /\ UNCHANGED <<caseStatus, tokenState, dumpToken, tokenUploads, dumpCase, digestRecorded,
                 coverage, downloadable, symbolRegistered>>

\* Promotion is a filesystem rename. It is deliberately separate from the
\* following ledger transition so a crash between the two remains representable.
PromoteObject(d) ==
  /\ d \in Dumps
  /\ dumpPhase[d] = "sealed"
  /\ blobState[d] = "staging"
  /\ blobState' = [blobState EXCEPT ![d] = "vault"]
  /\ action_taken' = "PromoteObject"
  /\ parameters' = [case |-> 0, token |-> 0, dump |-> d,
                      kind |-> NoCoverage]
  /\ UNCHANGED <<caseStatus, tokenState, dumpToken, tokenUploads, dumpPhase, dumpCase,
                 digestRecorded, validation, coverage, downloadable, symbolRegistered>>

\* This action is also the recovery step after a crash following promotion.
MarkQuarantined(d) ==
  /\ d \in Dumps
  /\ dumpPhase[d] = "sealed"
  /\ blobState[d] = "vault"
  /\ d \in digestRecorded
  /\ dumpPhase' = [dumpPhase EXCEPT ![d] = "quarantined"]
  /\ action_taken' = "MarkQuarantined"
  /\ parameters' = [case |-> 0, token |-> 0, dump |-> d,
                      kind |-> NoCoverage]
  /\ UNCHANGED <<caseStatus, tokenState, dumpToken, tokenUploads, dumpCase, blobState,
                 digestRecorded, validation, coverage, downloadable, symbolRegistered>>

AcceptDump(d, kind) ==
  /\ d \in Dumps
  /\ kind \in CoverageKinds
  /\ dumpPhase[d] = "quarantined"
  /\ blobState[d] = "vault"
  /\ d \in digestRecorded
  /\ dumpPhase' = [dumpPhase EXCEPT ![d] = "available"]
  /\ validation' = [validation EXCEPT ![d] = "valid"]
  /\ coverage' = [coverage EXCEPT ![d] = kind]
  /\ downloadable' = downloadable \cup {d}
  /\ action_taken' = "AcceptDump"
  /\ parameters' = [case |-> 0, token |-> 0, dump |-> d,
                      kind |-> kind]
  /\ UNCHANGED <<caseStatus, tokenState, dumpToken, tokenUploads, dumpCase, blobState,
                 digestRecorded, symbolRegistered>>

\* Structurally invalid input can remain in the vault until retention purges
\* it, but it is never downloadable through the normal analyst interface.
RejectDump(d) ==
  /\ d \in Dumps
  /\ dumpPhase[d] = "quarantined"
  /\ blobState[d] = "vault"
  /\ dumpPhase' = [dumpPhase EXCEPT ![d] = "rejected"]
  /\ validation' = [validation EXCEPT ![d] = "invalid"]
  /\ action_taken' = "RejectDump"
  /\ parameters' = [case |-> 0, token |-> 0, dump |-> d,
                      kind |-> NoCoverage]
  /\ UNCHANGED <<caseStatus, tokenState, dumpToken, tokenUploads, dumpCase, blobState,
                 digestRecorded, coverage, downloadable, symbolRegistered>>

\* Disable download before touching the filesystem. A crash in this phase is
\* recoverable and cannot re-authorize the dump.
BeginPurge(d) ==
  /\ d \in Dumps
  /\ dumpPhase[d] \in {"available", "rejected"}
  /\ dumpPhase' = [dumpPhase EXCEPT ![d] = "deleting"]
  /\ downloadable' = downloadable \ {d}
  /\ action_taken' = "BeginPurge"
  /\ parameters' = [case |-> 0, token |-> 0, dump |-> d,
                      kind |-> NoCoverage]
  /\ UNCHANGED <<caseStatus, tokenState, dumpToken, tokenUploads, dumpCase, blobState,
                 digestRecorded, validation, coverage, symbolRegistered>>

\* Finish purge after byte removal. Association, digest, validation, and
\* coverage remain as a minimal tombstone.
FinishPurge(d) ==
  /\ d \in Dumps
  /\ dumpPhase[d] = "deleting"
  /\ dumpPhase' = [dumpPhase EXCEPT ![d] = "deleted"]
  /\ blobState' = [blobState EXCEPT ![d] = "none"]
  /\ action_taken' = "FinishPurge"
  /\ parameters' = [case |-> 0, token |-> 0, dump |-> d,
                      kind |-> NoCoverage]
  /\ UNCHANGED <<caseStatus, tokenState, dumpToken, tokenUploads, dumpCase,
                 digestRecorded, validation, coverage, downloadable, symbolRegistered>>

\* Symbol ingest is idempotent: re-registering an identity leaves the
\* register unchanged (docs/symbols-design.md). The symbol slot rides the
\* generic dump wire field (the customer-slot-rides-case precedent).
IngestSymbol(m) ==
  /\ m \in Symbols
  /\ symbolRegistered' = symbolRegistered \cup {m}
  /\ action_taken' = "IngestSymbol"
  /\ parameters' = [case |-> 0, token |-> 0, dump |-> m,
                      kind |-> NoCoverage]
  /\ UNCHANGED <<caseStatus, tokenState, dumpToken, tokenUploads, dumpPhase,
                 dumpCase, blobState, digestRecorded, validation, coverage,
                 downloadable>>

PurgeSymbol(m) ==
  /\ m \in Symbols
  /\ m \in symbolRegistered
  /\ symbolRegistered' = symbolRegistered \ {m}
  /\ action_taken' = "PurgeSymbol"
  /\ parameters' = [case |-> 0, token |-> 0, dump |-> m,
                      kind |-> NoCoverage]
  /\ UNCHANGED <<caseStatus, tokenState, dumpToken, tokenUploads, dumpPhase,
                 dumpCase, blobState, digestRecorded, validation, coverage,
                 downloadable>>

Next ==
  \/ \E c \in Cases: StartInvestigation(c)
  \/ \E c \in Cases: WaitForCustomer(c)
  \/ \E c \in Cases: ResumeInvestigation(c)
  \/ \E c \in Cases: ResolveCase(c)
  \/ \E c \in Cases: CloseCase(c)
  \/ \E t \in Tokens: IssueToken(t)
  \/ \E t \in Tokens: RevokeToken(t)
  \/ \E t \in Tokens: ExpireToken(t)
  \/ \E t \in Tokens, d \in Dumps: BeginUpload(t, d)
  \/ \E d \in Dumps: SealUpload(d)
  \/ \E d \in Dumps: FailUpload(d)
  \/ \E d \in Dumps: PromoteObject(d)
  \/ \E d \in Dumps: MarkQuarantined(d)
  \/ \E d \in Dumps, kind \in CoverageKinds: AcceptDump(d, kind)
  \/ \E d \in Dumps: RejectDump(d)
  \/ \E d \in Dumps: BeginPurge(d)
  \/ \E d \in Dumps: FinishPurge(d)
  \/ \E m \in Symbols: IngestSymbol(m)
  \/ \E m \in Symbols: PurgeSymbol(m)

SafetySpec == Init /\ [][Next]_vars

\* ---------------------------------------------------------------------------
\* Safety invariants
\* ---------------------------------------------------------------------------

TypeOK ==
  /\ Len(caseStatus) = Cardinality(Cases)
  /\ \A c \in Cases: caseStatus[c] \in CaseStatuses
  /\ Len(tokenState) = Cardinality(Tokens)
  /\ \A t \in Tokens: tokenState[t] \in TokenStates
  /\ Len(dumpToken) = Cardinality(Dumps)
  /\ \A d \in Dumps: dumpToken[d] \in Tokens \cup {NoDump}
  /\ Len(tokenUploads) = Cardinality(Tokens)
  /\ \A t \in Tokens: tokenUploads[t] \in 0..TokenMaxUploads[t]
  /\ Len(dumpPhase) = Cardinality(Dumps)
  /\ \A d \in Dumps: dumpPhase[d] \in DumpPhases
  /\ Len(dumpCase) = Cardinality(Dumps)
  /\ \A d \in Dumps: dumpCase[d] \in Cases \cup {NoCase}
  /\ Len(blobState) = Cardinality(Dumps)
  /\ \A d \in Dumps: blobState[d] \in BlobStates
  /\ digestRecorded \subseteq Dumps
  /\ Len(validation) = Cardinality(Dumps)
  /\ \A d \in Dumps: validation[d] \in ValidationStates
  /\ Len(coverage) = Cardinality(Dumps)
  /\ \A d \in Dumps: coverage[d] \in CoverageKinds \cup {NoCoverage}
  /\ downloadable \subseteq Dumps
  /\ symbolRegistered \subseteq Symbols
  /\ action_taken \in {
       "Init", "StartInvestigation", "WaitForCustomer",
       "ResumeInvestigation", "ResolveCase", "CloseCase", "IssueToken",
       "RevokeToken", "ExpireToken", "BeginUpload",
       "SealUpload", "FailUpload", "PromoteObject", "MarkQuarantined",
       "AcceptDump", "RejectDump", "BeginPurge", "FinishPurge",
       "IngestSymbol", "PurgeSymbol"
     }
  /\ parameters \in [case: Cases \cup {0},
                       token: Tokens \cup {0},
                       dump: Dumps \cup {0},
                       kind: CoverageKinds \cup {NoCoverage}]

AssociationIntegrity ==
  /\ Len(CaseCustomer) = Cardinality(Cases)
  /\ \A c \in Cases: CaseCustomer[c] \in Customers
  /\ Len(TokenCase) = Cardinality(Tokens)
  /\ \A t \in Tokens: TokenCase[t] \in Cases
  /\ \A d \in Dumps:
       (dumpPhase[d] = "absent") <=> (dumpCase[d] = NoCase)

\* Dumps begun under a grant, enumerated over the fixed 1..2 model slots so
\* the invariant stays cheap arithmetic for Apalache (no set comprehensions).
DumpsUnderToken(t) ==
  (IF dumpToken[1] = t THEN 1 ELSE 0) + (IF dumpToken[2] = t THEN 1 ELSE 0)

TokenIntegrity ==
  /\ \A t \in Tokens:
       (tokenState[t] = "consumed") <=> (tokenUploads[t] = TokenMaxUploads[t])
  /\ \A t \in Tokens:
       tokenUploads[t] = DumpsUnderToken(t)
  /\ \A d \in Dumps:
       dumpToken[d] \in Tokens => dumpCase[d] = TokenCase[dumpToken[d]]
  /\ \A d \in Dumps:
       (dumpPhase[d] = "absent") <=> (dumpToken[d] = NoDump)

\* Slot bounds (docs/batch-upload-design.md): no grant delivers more dumps
\* than its slots, and no dump outlives its grant association.
TokenSlotBounds ==
  /\ \A t \in Tokens: tokenUploads[t] <= TokenMaxUploads[t]
  /\ \A t \in Tokens: DumpsUnderToken(t) <= TokenMaxUploads[t]

\* Closing revokes every still-usable grant for that case. Consumed grants and
\* their already-started dumps remain intact, and reopening mints no grant.
ClosedCaseHasNoIssuedGrant ==
  \A c \in Cases:
    caseStatus[c] = "closed" =>
      \A t \in Tokens:
        TokenCase[t] = c => tokenState[t] /= "issued"

AvailableHasEvidence ==
  /\ downloadable = {d \in Dumps: dumpPhase[d] = "available"}
  /\ \A d \in Dumps:
       dumpPhase[d] = "available" =>
         /\ blobState[d] = "vault"
         /\ d \in digestRecorded
         /\ validation[d] = "valid"
         /\ coverage[d] \in CoverageKinds

SealedAndQuarantinedHaveEvidence ==
  /\ \A d \in Dumps:
       dumpPhase[d] = "sealed" =>
         /\ blobState[d] \in {"staging", "vault"}
         /\ d \in digestRecorded
  /\ \A d \in Dumps:
       dumpPhase[d] = "quarantined" =>
         /\ blobState[d] = "vault"
         /\ d \in digestRecorded
         /\ validation[d] = "not-checked"

NoPrematureBlob ==
  \A d \in Dumps:
    blobState[d] /= "none" =>
      dumpPhase[d] \in {"receiving", "sealed", "quarantined",
                        "available", "rejected", "deleting"}

RejectedIsNotDownloadable ==
  \A d \in Dumps:
    dumpPhase[d] = "rejected" => d \notin downloadable

DeletingIsNotDownloadable ==
  \A d \in Dumps:
    dumpPhase[d] = "deleting" => d \notin downloadable

DeletedHasNoBlob ==
  \A d \in Dumps:
    dumpPhase[d] = "deleted" =>
      /\ blobState[d] = "none"
      /\ d \notin downloadable
      /\ dumpCase[d] \in Cases

\* The register holds only modeled identities, and identity uniqueness is
\* structural (a set). Ingest idempotence is action semantics:
\* IngestSymbol(m); IngestSymbol(m) leaves the register equal to one ingest.
SymbolInvariant ==
  symbolRegistered \subseteq Symbols

SafetyInvariant ==
  /\ TypeOK
  /\ SymbolInvariant
  /\ AssociationIntegrity
  /\ TokenIntegrity
  /\ TokenSlotBounds
  /\ ClosedCaseHasNoIssuedGrant
  /\ AvailableHasEvidence
  /\ SealedAndQuarantinedHaveEvidence
  /\ NoPrematureBlob
  /\ RejectedIsNotDownloadable
  /\ DeletingIsNotDownloadable
  /\ DeletedHasNoBlob

=============================================================================
