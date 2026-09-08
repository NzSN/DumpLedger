--------------------------- MODULE DumpLedgerTransfer ---------------------------
(* Companion model of the as-built export/import transfer behavior
   (docs/import-export-design.md). This module EXTENDS DumpLedger and adds one
   abstract bundle slot plus a single-job transfer lock; it reuses the base
   dump lifecycle actions so imported dumps must re-earn "available" through
   quarantine exactly like uploaded ones.

   Scope and abstractions (read before extending):
   - DumpLedger.tla is NOT modified; this spec stays outside the generated
     model interface and the MBT trace corpus. action_taken/parameters (trace
     annotations consumed by the model-interface compiler) stay frozen at
     their Init values: the transfer spec is checked by TLC only.
   - One bundle slot models the exports directory. Bundle "bytes" are
     abstract: integrity is represented by `bad`, at most one tampered dump,
     matching the e2e evidence (a single flipped byte) and the pipeline's
     one-at-a-time verification.
   - Export never corrupts its own bundle: corruption enters only via
     TamperBundle (bytes flipped between seal and import), so "sealed"
     bundles model byte-exact exports.
   - In-flight dumps (receiving/sealed/quarantined/deleting) are simply
     absent from the bundle; import only ever materializes declared dumps
     ("declared === undefined -> continue" in import.ts), so "skipped never
     imported" is structural, not invariant-backed.
   - Audit-event replay and the tar/filesystem layer are not modeled; the
     base spec has no audit variable. Their guarantees are covered by
     integration and e2e tests instead.
   - A crash mid-import is ImportHardFail: partial ledger/vault state
     persists and no FinishImport marker exists, mirroring importBundle's
     catch path. *)
EXTENDS DumpLedger


BundleStatuses ==
  {"absent", "running", "sealed", "failed",
   "importing", "finished", "import-failed"}

VARIABLES
  \* @type: Bool;
  fingerprintMatches,  (* does the bundle's grant-key fingerprint equal this
                          instance's key? chosen once per behavior; FALSE is
                          the policy case (issued grants become revoked) *)
  \* @type: { status: Str, promised: Set(Int), rejected: Set(Int), deleted: Set(Int), bad: Int };
  bundle,    (* the single abstract bundle: promised dumps carry vault-byte
                entries; rejected/deleted dumps are metadata-only tombstones;
                bad is the (at most one) tampered promised dump, 0 = none *)
  \* @type: Set(Int);
  custDone,  (* customer slots whose import action has run *)
  \* @type: Set(Int);
  caseDone,  (* case slots whose import action has run *)
  \* @type: Set(Int);
  done,      (* dump slots whose import disposition action has run *)
  \* @type: Set(Int);
  tokDone    (* token slots whose grant-import action has run *)

tvars == <<fingerprintMatches, bundle, custDone, caseDone, done, tokDone>>

NoBundle == [status |-> "absent", promised |-> {}, rejected |-> {},
             deleted |-> {}, bad |-> 0]

TransferInit ==
  /\ Init
  /\ fingerprintMatches \in BOOLEAN
  /\ bundle = NoBundle
  /\ custDone = {}
  /\ caseDone = {}
  /\ done = {}
  /\ tokDone = {}

(* Fresh ledger: the import precondition. BeginImport requires every table
   empty; in this abstraction that is exactly the base Init shape, and no
   base action can return to it (dumps never return to "absent", tokens
   never to "unused", case status never to "new"). *)
FreshLedger ==
  /\ \A c \in Cases: caseStatus[c] = "new"
  /\ \A t \in Tokens: tokenState[t] = "unused"
  /\ \A d \in Dumps: dumpPhase[d] = "absent"

(* Lifecycle actions (lite versions of the base actions: identical guards and
   effects on lifecycle state, but the trace annotations stay frozen). These
   serve BOTH the live upload path and the imported-dump path. *)
IssueTokenI(t) ==
  /\ t \in Tokens
  /\ tokenState[t] = "unused"
  /\ caseStatus[TokenCase[t]] /= "closed"
  /\ tokenState' = [tokenState EXCEPT ![t] = "issued"]
  /\ UNCHANGED <<caseStatus, tokenDump, dumpPhase, dumpCase, blobState,
                 digestRecorded, validation, coverage, downloadable,
                 action_taken, parameters, bundle, done, tokDone, fingerprintMatches, custDone, caseDone>>

BeginUploadI(t, d) ==
  /\ t \in Tokens
  /\ d \in Dumps
  /\ tokenState[t] = "issued"
  /\ caseStatus[TokenCase[t]] /= "closed"
  /\ tokenDump[t] = NoDump
  /\ dumpPhase[d] = "absent"
  /\ dumpCase[d] = NoCase
  /\ tokenState' = [tokenState EXCEPT ![t] = "consumed"]
  /\ tokenDump' = [tokenDump EXCEPT ![t] = d]
  /\ dumpPhase' = [dumpPhase EXCEPT ![d] = "receiving"]
  /\ dumpCase' = [dumpCase EXCEPT ![d] = TokenCase[t]]
  /\ blobState' = [blobState EXCEPT ![d] = "staging"]
  /\ UNCHANGED <<caseStatus, digestRecorded, validation, coverage,
                 downloadable, action_taken, parameters, bundle, done,
                 tokDone, fingerprintMatches, custDone, caseDone>>

SealUploadI(d) ==
  /\ d \in Dumps
  /\ dumpPhase[d] = "receiving"
  /\ blobState[d] = "staging"
  /\ dumpPhase' = [dumpPhase EXCEPT ![d] = "sealed"]
  /\ digestRecorded' = digestRecorded \cup {d}
  /\ UNCHANGED <<caseStatus, tokenState, tokenDump, dumpCase, blobState,
                 validation, coverage, downloadable, action_taken,
                 parameters, bundle, done, tokDone, fingerprintMatches, custDone, caseDone>>

PromoteI(d) ==
  /\ d \in Dumps
  /\ dumpPhase[d] = "sealed"
  /\ blobState[d] = "staging"
  /\ blobState' = [blobState EXCEPT ![d] = "vault"]
  /\ UNCHANGED <<caseStatus, tokenState, tokenDump, dumpPhase, dumpCase,
                 digestRecorded, validation, coverage, downloadable,
                 action_taken, parameters, bundle, done, tokDone, fingerprintMatches, custDone, caseDone>>

QuarantineI(d) ==
  /\ d \in Dumps
  /\ dumpPhase[d] = "sealed"
  /\ blobState[d] = "vault"
  /\ d \in digestRecorded
  /\ dumpPhase' = [dumpPhase EXCEPT ![d] = "quarantined"]
  /\ UNCHANGED <<caseStatus, tokenState, tokenDump, dumpCase, blobState,
                 digestRecorded, validation, coverage, downloadable,
                 action_taken, parameters, bundle, done, tokDone, fingerprintMatches, custDone, caseDone>>

AcceptI(d, kind) ==
  /\ d \in Dumps
  /\ kind \in CoverageKinds
  /\ dumpPhase[d] = "quarantined"
  /\ blobState[d] = "vault"
  /\ d \in digestRecorded
  /\ dumpPhase' = [dumpPhase EXCEPT ![d] = "available"]
  /\ validation' = [validation EXCEPT ![d] = "valid"]
  /\ coverage' = [coverage EXCEPT ![d] = kind]
  /\ downloadable' = downloadable \cup {d}
  /\ UNCHANGED <<caseStatus, tokenState, tokenDump, dumpCase, blobState,
                 digestRecorded, action_taken, parameters, bundle, done,
                 tokDone, fingerprintMatches, custDone, caseDone>>

RejectI(d) ==
  /\ d \in Dumps
  /\ dumpPhase[d] = "quarantined"
  /\ blobState[d] = "vault"
  /\ dumpPhase' = [dumpPhase EXCEPT ![d] = "rejected"]
  /\ validation' = [validation EXCEPT ![d] = "invalid"]
  /\ UNCHANGED <<caseStatus, tokenState, tokenDump, dumpCase, blobState,
                 digestRecorded, coverage, downloadable, action_taken,
                 parameters, bundle, done, tokDone, fingerprintMatches, custDone, caseDone>>

(* EXPORT: selection partitions non-absent dumps by phase; any mid-copy race
   (vanishing bytes under a concurrent purge) aborts the whole export, so a
   sealed bundle is byte-exact by construction. *)
ExportStart ==
  /\ bundle.status \in {"absent", "sealed", "failed",
                        "finished", "import-failed"}
  /\ bundle' = [status |-> "running",
                promised |-> {d \in Dumps: dumpPhase[d] = "available"},
                rejected |-> {d \in Dumps: dumpPhase[d] = "rejected"},
                deleted |-> {d \in Dumps: dumpPhase[d] = "deleted"},
                bad |-> 0]
  /\ done' = {}
  /\ custDone' = {}
  /\ caseDone' = {}
  /\ tokDone' = {}
  /\ UNCHANGED <<caseStatus, tokenState, tokenDump, dumpPhase, dumpCase,
                 blobState, digestRecorded, validation, coverage,
                 downloadable, action_taken, parameters, fingerprintMatches>>

ExportSeal ==
  /\ bundle.status = "running"
  /\ bundle' = [bundle EXCEPT !.status = "sealed"]
  /\ UNCHANGED <<caseStatus, tokenState, tokenDump, dumpPhase, dumpCase,
                 blobState, digestRecorded, validation, coverage,
                 downloadable, action_taken, parameters, done, tokDone, fingerprintMatches, custDone, caseDone>>

ExportFail ==
  /\ bundle.status = "running"
  /\ bundle' = [bundle EXCEPT !.status = "failed"]
  /\ UNCHANGED <<caseStatus, tokenState, tokenDump, dumpPhase, dumpCase,
                 blobState, digestRecorded, validation, coverage,
                 downloadable, action_taken, parameters, done, tokDone, fingerprintMatches, custDone, caseDone>>

(* External tampering between seal and import: exactly one promised dump's
   bytes are flipped (the e2e journey-2 shape). *)
TamperBundle(d) ==
  /\ bundle.status = "sealed"
  /\ d \in bundle.promised
  /\ bundle' = [bundle EXCEPT !.bad = d]
  /\ UNCHANGED <<caseStatus, tokenState, tokenDump, dumpPhase, dumpCase,
                 blobState, digestRecorded, validation, coverage,
                 downloadable, action_taken, parameters, done, tokDone, fingerprintMatches, custDone, caseDone>>

DeleteBundle ==
  /\ bundle.status \in {"sealed", "failed", "finished", "import-failed"}
  /\ bundle' = NoBundle
  /\ done' = {}
  /\ tokDone' = {}
  /\ custDone' = {}
  /\ caseDone' = {}
  /\ UNCHANGED <<caseStatus, tokenState, tokenDump, dumpPhase, dumpCase,
                 blobState, digestRecorded, validation, coverage,
                 downloadable, action_taken, parameters, fingerprintMatches>>

(* A fresh target instance: the operator wipes or starts a new instance
   while the sealed bundle sits on disk -- the real deployment shape (the e2e
   journey spawns a second process with an empty data dir). Without this the
   model's single ledger cannot be both the export source and the fresh
   import target. *)
WipeInstance ==
  /\ bundle.status = "sealed"
  /\ ~FreshLedger
  /\ caseStatus' = <<"new", "new">>        (* tuple literals: the vars are *)
  /\ tokenState' = <<"unused", "unused">>  (* typed Seq(..) in the base    *)
  /\ tokenDump' = <<NoDump, NoDump>>       (* spec; [x \in 1..2 |-> v]     *)
  /\ dumpPhase' = <<"absent", "absent">>   (* would not type-unify under   *)
  /\ dumpCase' = <<NoCase, NoCase>>        (* Apalache's Snowcat           *)
  /\ blobState' = <<"none", "none">>
  /\ digestRecorded' = {}
  /\ validation' = <<"not-checked", "not-checked">>
  /\ coverage' = <<NoCoverage, NoCoverage>>
  /\ downloadable' = {}
  /\ custDone' = {}
  /\ caseDone' = {}
  /\ done' = {}
  /\ tokDone' = {}
  /\ UNCHANGED <<action_taken, parameters, fingerprintMatches, bundle>>

(* IMPORT: gated by FreshLedger (the engine's empty-table guard), consumes a
   sealed bundle, and materializes dumps through the SAME lifecycle
   actions. *)
ImportStart ==
  /\ bundle.status = "sealed"
  /\ FreshLedger
  /\ bundle' = [bundle EXCEPT !.status = "importing"]
  /\ done' = {}
  /\ tokDone' = {}
  /\ custDone' = {}
  /\ caseDone' = {}
  /\ UNCHANGED <<caseStatus, tokenState, tokenDump, dumpPhase, dumpCase,
                 blobState, digestRecorded, validation, coverage,
                 downloadable, action_taken, parameters, fingerprintMatches>>

(* Entity rows travel in dependency order: customers before cases before
   grants before dumps. The guards here are the ledger's FK checks. *)
ImportCustomer(c) ==
  /\ bundle.status = "importing"
  /\ c \in Customers
  /\ c \notin custDone
  /\ custDone' = custDone \cup {c}
  /\ UNCHANGED <<caseStatus, tokenState, tokenDump, dumpPhase, dumpCase,
                 blobState, digestRecorded, validation, coverage,
                 downloadable, action_taken, parameters, fingerprintMatches,
                 bundle, caseDone, done, tokDone>>

ImportCase(c) ==
  /\ bundle.status = "importing"
  /\ c \in Cases
  /\ c \notin caseDone
  /\ CaseCustomer[c] \in custDone        (* FK: the customer row exists *)
  /\ caseDone' = caseDone \cup {c}
  /\ UNCHANGED <<caseStatus, tokenState, tokenDump, dumpPhase, dumpCase,
                 blobState, digestRecorded, validation, coverage,
                 downloadable, action_taken, parameters, fingerprintMatches,
                 bundle, custDone, done, tokDone>>

(* Grant-key fingerprint policy: a grant exported under a different key must
   never become usable; it lands directly in the terminal "revoked" state. *)
ImportTokens(t) ==
  /\ bundle.status = "importing"
  /\ t \in Tokens
  /\ tokenState[t] = "unused"
  /\ TokenCase[t] \in caseDone           (* FK: the case row exists *)
  /\ tokenState' = [tokenState EXCEPT
       ![t] = IF fingerprintMatches THEN "issued" ELSE "revoked"]
  /\ tokDone' = tokDone \cup {t}
  /\ UNCHANGED <<caseStatus, tokenDump, dumpPhase, dumpCase, blobState,
                 digestRecorded, validation, coverage, downloadable,
                 action_taken, parameters, bundle, done, fingerprintMatches, custDone, caseDone>>

(* Verified bytes: staged and hashed to match the manifest, the row is
   created sealed/staging exactly like a sealed upload, then the shared
   PromoteI/QuarantineI/AcceptI path applies. *)
ImportDumpOk(d, c) ==
  /\ bundle.status = "importing"
  /\ d \in bundle.promised
  /\ bundle.bad /= d
  /\ c \in Cases
  /\ c \in caseDone             (* FK: the case row exists *)
  /\ dumpPhase[d] = "absent"
  /\ dumpCase[d] = NoCase
  /\ dumpPhase' = [dumpPhase EXCEPT ![d] = "sealed"]
  /\ blobState' = [blobState EXCEPT ![d] = "staging"]
  /\ dumpCase' = [dumpCase EXCEPT ![d] = c]
  /\ digestRecorded' = digestRecorded \cup {d}
  /\ done' = done \cup {d}
  /\ UNCHANGED <<caseStatus, tokenState, tokenDump, validation, coverage,
                 downloadable, action_taken, parameters, bundle, tokDone, fingerprintMatches, custDone, caseDone>>

(* SHA-256/size mismatch (including the tampered dump): rejected tombstone,
   no bytes, never downloadable -- import.ts mismatchTombstone. *)
ImportDumpReject(d, c) ==
  /\ bundle.status = "importing"
  /\ d = bundle.bad
  /\ d \in bundle.promised
  /\ c \in Cases
  /\ c \in caseDone             (* FK: the case row exists *)
  /\ dumpPhase[d] = "absent"
  /\ dumpCase[d] = NoCase
  /\ dumpPhase' = [dumpPhase EXCEPT ![d] = "rejected"]
  /\ blobState' = [blobState EXCEPT ![d] = "none"]
  /\ dumpCase' = [dumpCase EXCEPT ![d] = c]
  /\ validation' = [validation EXCEPT ![d] = "transfer-failed"]
  /\ done' = done \cup {d}
  /\ UNCHANGED <<caseStatus, tokenState, tokenDump, digestRecorded,
                 coverage, downloadable, action_taken, parameters, bundle,
                 tokDone, fingerprintMatches, custDone, caseDone>>

(* Exported tombstones: metadata only, blobState none. Validation abstracts
   the source-recorded value ("invalid" covers the exported-rejected cases). *)
ImportDumpTombR(d, c) ==
  /\ bundle.status = "importing"
  /\ d \in bundle.rejected
  /\ c \in Cases
  /\ c \in caseDone             (* FK: the case row exists *)
  /\ dumpPhase[d] = "absent"
  /\ dumpCase[d] = NoCase
  /\ dumpPhase' = [dumpPhase EXCEPT ![d] = "rejected"]
  /\ blobState' = [blobState EXCEPT ![d] = "none"]
  /\ dumpCase' = [dumpCase EXCEPT ![d] = c]
  /\ validation' = [validation EXCEPT ![d] = "invalid"]
  /\ done' = done \cup {d}
  /\ UNCHANGED <<caseStatus, tokenState, tokenDump, digestRecorded,
                 coverage, downloadable, action_taken, parameters, bundle,
                 tokDone, fingerprintMatches, custDone, caseDone>>

ImportDumpTombD(d, c) ==
  /\ bundle.status = "importing"
  /\ d \in bundle.deleted
  /\ c \in Cases
  /\ c \in caseDone             (* FK: the case row exists *)
  /\ dumpPhase[d] = "absent"
  /\ dumpCase[d] = NoCase
  /\ dumpPhase' = [dumpPhase EXCEPT ![d] = "deleted"]
  /\ blobState' = [blobState EXCEPT ![d] = "none"]
  /\ dumpCase' = [dumpCase EXCEPT ![d] = c]
  /\ validation' = [validation EXCEPT ![d] = "invalid"]
  /\ done' = done \cup {d}
  /\ UNCHANGED <<caseStatus, tokenState, tokenDump, digestRecorded,
                 coverage, downloadable, action_taken, parameters, bundle,
                 tokDone, fingerprintMatches, custDone, caseDone>>

(* FinishImport requires every declared dump disposed of; it audits only. *)
ImportFinish ==
  /\ bundle.status = "importing"
  /\ (bundle.promised \cup bundle.rejected \cup bundle.deleted) \subseteq done
  /\ custDone = Customers
  /\ caseDone = Cases
  /\ tokDone = Tokens
  /\ bundle' = [bundle EXCEPT !.status = "finished"]
  /\ UNCHANGED <<caseStatus, tokenState, tokenDump, dumpPhase, dumpCase,
                 blobState, digestRecorded, validation, coverage,
                 downloadable, action_taken, parameters, done, tokDone, fingerprintMatches, custDone, caseDone>>

(* Any hard failure after BeginImport: partial state persists, no
   FinishImport marker (importBundle's catch path). *)
ImportHardFail ==
  /\ bundle.status = "importing"
  /\ bundle' = [bundle EXCEPT !.status = "import-failed"]
  /\ UNCHANGED <<caseStatus, tokenState, tokenDump, dumpPhase, dumpCase,
                 blobState, digestRecorded, validation, coverage,
                 downloadable, action_taken, parameters, done, tokDone, fingerprintMatches, custDone, caseDone>>

TransferNext ==
  \/ \E t \in Tokens: IssueTokenI(t)
  \/ \E t \in Tokens, d \in Dumps: BeginUploadI(t, d)
  \/ \E d \in Dumps: SealUploadI(d)
  \/ \E d \in Dumps: PromoteI(d)
  \/ \E d \in Dumps: QuarantineI(d)
  \/ \E d \in Dumps, kind \in CoverageKinds: AcceptI(d, kind)
  \/ \E d \in Dumps: RejectI(d)
  \/ ExportStart
  \/ ExportSeal
  \/ ExportFail
  \/ \E d \in Dumps: TamperBundle(d)
  \/ DeleteBundle
  \/ WipeInstance
  \/ ImportStart
  \/ \E c \in Customers: ImportCustomer(c)
  \/ \E c \in Cases: ImportCase(c)
  \/ \E t \in Tokens: ImportTokens(t)
  \/ \E d \in Dumps, c \in Cases: ImportDumpOk(d, c)
  \/ \E d \in Dumps, c \in Cases: ImportDumpReject(d, c)
  \/ \E d \in Dumps, c \in Cases: ImportDumpTombR(d, c)
  \/ \E d \in Dumps, c \in Cases: ImportDumpTombD(d, c)
  \/ ImportFinish
  \/ ImportHardFail

allVars == <<caseStatus, tokenState, tokenDump, dumpPhase, dumpCase,
             blobState, digestRecorded, validation, coverage, downloadable,
             action_taken, parameters, fingerprintMatches, bundle, custDone,
             caseDone, done, tokDone>>

TransferSpec == TransferInit /\ [][TransferNext]_allVars

(* Transfer safety, checked TOGETHER with the base SafetyInvariant: the base
   invariants (AvailableHasEvidence, NoPrematureBlob, DeletedHasNoBlob, ...)
   hold for dumps that entered the ledger through import, because import
   reuses the same lifecycle actions. *)
BundleTypeOK ==
  /\ bundle.status \in BundleStatuses
  /\ bundle.promised \subseteq Dumps
  /\ bundle.rejected \subseteq Dumps
  /\ bundle.deleted \subseteq Dumps
  /\ bundle.bad \in Dumps \cup {0}
  /\ custDone \subseteq Customers
  /\ caseDone \subseteq Cases

BundleStructure ==
  /\ bundle.status /= "absent" =>
       /\ bundle.promised \cap bundle.rejected = {}
       /\ bundle.promised \cap bundle.deleted = {}
       /\ bundle.rejected \cap bundle.deleted = {}
       /\ bundle.bad \in bundle.promised \cup {0}
  /\ bundle.status = "running" => bundle.bad = 0

(* Every dump whose import disposition ran landed where the manifest and the
   verification outcome dictate -- the "with datas" guarantees:
     tampered          -> rejected, never available
     exported rejected -> rejected tombstone, no bytes
     exported deleted  -> deleted tombstone, no bytes *)
ImportDisposition ==
  \A d \in done:
    /\ (d = bundle.bad) => dumpPhase[d] = "rejected"
    /\ (d \in bundle.rejected) => dumpPhase[d] = "rejected"
    /\ (d \in bundle.deleted) => dumpPhase[d] = "deleted"
    /\ (d \in bundle.rejected \cup bundle.deleted) =>
         /\ blobState[d] = "none"
         /\ d \notin downloadable

(* Grant-key fingerprint policy: under a mismatched key no imported grant is
   ever issuable; the import action lands it directly in "revoked". *)
FingerprintPolicy ==
  (~fingerprintMatches) =>
    \A t \in tokDone: tokenState[t] = "revoked"

\* Entity import respects foreign-key order: a case only after its
\* customer, a grant only after its case, a dump only after its case.
EntityOrder ==
  /\ \A c \in caseDone: CaseCustomer[c] \in custDone
  /\ \A t \in tokDone: TokenCase[t] \in caseDone
  /\ \A d \in done: dumpCase[d] \in caseDone

TransferSafety ==
  /\ BundleTypeOK
  /\ BundleStructure
  /\ ImportDisposition
  /\ EntityOrder
  /\ FingerprintPolicy

(* Combined check target for bounded symbolic verification (Apalache checks
   one invariant per run): the base lifecycle invariants must hold for dumps
   that entered through import as well. *)
TransferSafetyFull == SafetyInvariant /\ TransferSafety

=============================================================================
