--------------------------- MODULE DumpLedgerTransfer ---------------------------
(* Companion model of the as-built export/import transfer behavior
   (docs/import-export-design.md). This module EXTENDS DumpLedger and adds one
   abstract bundle slot plus a single-job transfer lock; it reuses the base
   dump lifecycle actions so imported dumps must re-earn "available" through
   quarantine exactly like uploaded ones.

   MBT surface: every transition is annotated through action_taken/parameters
   (the wire consumed by the MirrorECMA low-level replay path), so this spec
   drives the trace corpus in test/fixtures/mbt/transfer-traces/ and the
   handwritten client StateComputer in src/mbt/. The lite lifecycle actions
   deliberately reuse the base wire labels: they are the same public
   operations, additionally constrained to leave the transfer variables
   unchanged. The purge lites exist because exported deleted tombstones are
   real: without them bundle.deleted (and therefore ImportDumpTombD) would
   be unreachable.

   Scope and abstractions (read before extending):
   - DumpLedger.tla is NOT modified. The base TypeOK freezes the base wire
     label universe and the base TokenIntegrity requires every consumed
     grant's dump to stay associated, so this module checks
     TransferTypeOK/TransferTokenIntegrity (below) instead; every other base
     invariant is checked unchanged.
   - One bundle slot models the exports directory. Bundle "bytes" are
     abstract: integrity is represented by `bad`, at most one tampered dump,
     matching the e2e evidence (a single flipped byte) and the pipeline's
     one-at-a-time verification.
   - The bundle carries the export-time SNAPSHOT the real tar bundle
     preserves: case statuses (cstat), grant states and consumed-dump links
     (gstate/gdump), dump cases (dcase), and deleted-dump coverage (dcov).
     The real import lands these columns verbatim -- a grant-key fingerprint
     mismatch only revokes grants that were still "issued" -- so the model
     must replay them verbatim. Anything weaker mis-models the real
     tombstoneRecord/mismatchTombstone rows (a deleted-after-available dump
     keeps validation "valid" and its coverage kind; every tombstone keeps
     the recorded sha256).
   - Export never corrupts its own bundle: corruption enters only via
     TamperBundle (bytes flipped between seal and import), so "sealed"
     bundles model byte-exact exports.
   - In-flight dumps (receiving/sealed/quarantined/deleting) are simply
     absent from the bundle; import only ever materializes declared dumps
     ("declared === undefined -> continue" in import.ts), so "skipped never
     imported" is structural, not invariant-backed. A consumed grant whose
     dump was skipped imports with its consumed-by link dangling, exactly
     like the real consumed_by_dump_id column (no REFERENCES to dumps).
   - Audit-event replay and the tar/filesystem layer are not modeled; the
     base spec has no audit variable. Their guarantees are covered by
     integration and e2e tests instead.
   - A crash mid-import is ImportHardFail: partial ledger/vault state
     persists and no FinishImport marker exists, mirroring importBundle's
     catch path.
   - One transfer cycle per behavior, and the target stays frozen until the
     restore runs: model slots alias across WipeInstance (a pre-wipe dump and
     a post-wipe dump share a slot), which reality never does because real
     identifiers differ. The model therefore (a) forbids ExportStart once
     wiped (a second cycle would reset the import-progress tracking that
     doubles as case-presence on the target), (b) forbids issuing grants for
     cases the target has not imported yet, and (c) forbids uploads on a
     dump slot referenced by any consumed grant -- the dangling
     consumed-by link permanently owns its slot, exactly like the real
     dangling consumed_by_dump_id row that can never be re-referenced. *)
EXTENDS DumpLedger


BundleStatuses ==
  {"absent", "running", "sealed", "failed",
   "importing", "finished", "import-failed"}

VARIABLES
  \* @type: Bool;
  wiped,       (* FALSE on the original ledger generation, TRUE forever after
                  WipeInstance: the slot-ownership discipline below keys off
                  it, and the adapter reports which generation is live *)
  \* @type: Bool;
  fingerprintMatches,  (* does the bundle's grant-key fingerprint equal the
                          importing instance's key? chosen once per behavior;
                          FALSE is the policy case (issued grants import as
                          revoked; grants in any other state are preserved) *)
  \* @type: { status: Str, promised: Set(Int), rejected: Set(Int), deleted: Set(Int), bad: Int, cstat: Seq(Str), gstate: Seq(Str), gdump: Seq(Int), dcase: Seq(Int), dcov: Seq(Str) };
  bundle,    (* the single abstract bundle: promised dumps carry vault-byte
                entries; rejected/deleted dumps are metadata-only tombstones;
                bad is the (at most one) tampered promised dump, 0 = none;
                cstat/gstate/gdump/dcase/dcov are the export-time snapshots of
                caseStatus/tokenState/tokenDump/dumpCase/deleted coverage *)
  \* @type: Set(Int);
  custDone,  (* customer slots whose import action has run *)
  \* @type: Set(Int);
  caseDone,  (* case slots whose import action has run *)
  \* @type: Set(Int);
  done,      (* dump slots whose import disposition action has run *)
  \* @type: Set(Int);
  tokDone    (* token slots whose grant-import action has run *)

tvars == <<wiped, fingerprintMatches, bundle, custDone, caseDone, done, tokDone>>

\* @type: { status: Str, promised: Set(Int), rejected: Set(Int), deleted: Set(Int), bad: Int, cstat: Seq(Str), gstate: Seq(Str), gdump: Seq(Int), dcase: Seq(Int), dcov: Seq(Str) };
NoBundle == [status |-> "absent", promised |-> {}, rejected |-> {},
             deleted |-> {}, bad |-> 0,
             cstat |-> <<"new", "new">>, gstate |-> <<"unused", "unused">>,
             gdump |-> <<NoDump, NoDump>>, dcase |-> <<NoCase, NoCase>>,
             dcov |-> <<NoCoverage, NoCoverage>>]

TransferInit ==
  /\ Init
  /\ wiped = FALSE
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

(* Lifecycle actions (the base actions plus UNCHANGED transfer variables,
   reusing the base wire labels: identical guards and effects on lifecycle
   state). These serve BOTH the live upload path and the imported-dump
   path. *)
IssueTokenI(t) ==
  /\ t \in Tokens
  /\ tokenState[t] = "unused"
  /\ caseStatus[TokenCase[t]] /= "closed"
     (* on the wiped target the case row must exist: it was imported *)
  /\ ~wiped \/ TokenCase[t] \in caseDone
  /\ tokenState' = [tokenState EXCEPT ![t] = "issued"]
  /\ action_taken' = "IssueToken"
  /\ parameters' = [case |-> 0, token |-> t, dump |-> 0,
                      kind |-> NoCoverage]
  /\ UNCHANGED <<caseStatus, tokenDump, dumpPhase, dumpCase, blobState,
                 digestRecorded, validation, coverage, downloadable, bundle,
                 done, tokDone, fingerprintMatches, custDone, caseDone,
                 wiped>>

BeginUploadI(t, d) ==
  /\ t \in Tokens
  /\ d \in Dumps
  /\ tokenState[t] = "issued"
  /\ caseStatus[TokenCase[t]] /= "closed"
  /\ tokenDump[t] = NoDump
  /\ dumpPhase[d] = "absent"
  /\ dumpCase[d] = NoCase
     (* a consumed grant's consumed-by link owns its dump slot forever:
        post-wipe that link may dangle onto a skipped dump, and the slot
        must never host a different live dump (reality: different real id).
        Neither an installed link (tokenDump) nor a link the sealed bundle
        still carries pending import (gdump of a grant not yet imported)
        may be displaced; and while an import is running, a slot the bundle
        will materialize is equally off-limits. *)
  /\ \A x \in Tokens: tokenDump[x] /= d
  /\ \A x \in Tokens: x \notin tokDone => bundle.gdump[x] /= d
  /\ bundle.status = "importing" =>
       d \notin (bundle.promised \cup bundle.rejected \cup bundle.deleted)
  /\ tokenState' = [tokenState EXCEPT ![t] = "consumed"]
  /\ tokenDump' = [tokenDump EXCEPT ![t] = d]
  /\ dumpPhase' = [dumpPhase EXCEPT ![d] = "receiving"]
  /\ dumpCase' = [dumpCase EXCEPT ![d] = TokenCase[t]]
  /\ blobState' = [blobState EXCEPT ![d] = "staging"]
  /\ action_taken' = "BeginUpload"
  /\ parameters' = [case |-> 0, token |-> t, dump |-> d,
                      kind |-> NoCoverage]
  /\ UNCHANGED <<caseStatus, digestRecorded, validation, coverage,
                 downloadable, bundle, done, tokDone, fingerprintMatches,
                 custDone, caseDone, wiped>>

SealUploadI(d) ==
  /\ d \in Dumps
  /\ dumpPhase[d] = "receiving"
  /\ blobState[d] = "staging"
  /\ dumpPhase' = [dumpPhase EXCEPT ![d] = "sealed"]
  /\ digestRecorded' = digestRecorded \cup {d}
  /\ action_taken' = "SealUpload"
  /\ parameters' = [case |-> 0, token |-> 0, dump |-> d,
                      kind |-> NoCoverage]
  /\ UNCHANGED <<caseStatus, tokenState, tokenDump, dumpCase, blobState,
                 validation, coverage, downloadable, bundle, done, tokDone,
                 fingerprintMatches, custDone, caseDone, wiped>>

PromoteI(d) ==
  /\ d \in Dumps
  /\ dumpPhase[d] = "sealed"
  /\ blobState[d] = "staging"
  /\ blobState' = [blobState EXCEPT ![d] = "vault"]
  /\ action_taken' = "PromoteObject"
  /\ parameters' = [case |-> 0, token |-> 0, dump |-> d,
                      kind |-> NoCoverage]
  /\ UNCHANGED <<caseStatus, tokenState, tokenDump, dumpPhase, dumpCase,
                 digestRecorded, validation, coverage, downloadable, bundle,
                 done, tokDone, fingerprintMatches, custDone, caseDone,
                 wiped>>

QuarantineI(d) ==
  /\ d \in Dumps
  /\ dumpPhase[d] = "sealed"
  /\ blobState[d] = "vault"
  /\ d \in digestRecorded
  /\ dumpPhase' = [dumpPhase EXCEPT ![d] = "quarantined"]
  /\ action_taken' = "MarkQuarantined"
  /\ parameters' = [case |-> 0, token |-> 0, dump |-> d,
                      kind |-> NoCoverage]
  /\ UNCHANGED <<caseStatus, tokenState, tokenDump, dumpCase, blobState,
                 digestRecorded, validation, coverage, downloadable, bundle,
                 done, tokDone, fingerprintMatches, custDone, caseDone,
                 wiped>>

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
  /\ action_taken' = "AcceptDump"
  /\ parameters' = [case |-> 0, token |-> 0, dump |-> d, kind |-> kind]
  /\ UNCHANGED <<caseStatus, tokenState, tokenDump, dumpCase, blobState,
                 digestRecorded, bundle, done, tokDone, fingerprintMatches,
                 custDone, caseDone, wiped>>

RejectI(d) ==
  /\ d \in Dumps
  /\ dumpPhase[d] = "quarantined"
  /\ blobState[d] = "vault"
  /\ dumpPhase' = [dumpPhase EXCEPT ![d] = "rejected"]
  /\ validation' = [validation EXCEPT ![d] = "invalid"]
  /\ action_taken' = "RejectDump"
  /\ parameters' = [case |-> 0, token |-> 0, dump |-> d,
                      kind |-> NoCoverage]
  /\ UNCHANGED <<caseStatus, tokenState, tokenDump, dumpCase, blobState,
                 digestRecorded, coverage, downloadable, bundle, done,
                 tokDone, fingerprintMatches, custDone, caseDone, wiped>>

(* Retention: purging lands a deleted tombstone (association, digest,
   validation, and coverage survive). Exported tombstones are exactly what
   makes bundle.deleted -- and therefore ImportDumpTombD -- reachable. *)
BeginPurgeI(d) ==
  /\ d \in Dumps
  /\ dumpPhase[d] \in {"available", "rejected"}
  /\ dumpPhase' = [dumpPhase EXCEPT ![d] = "deleting"]
  /\ downloadable' = downloadable \ {d}
  /\ action_taken' = "BeginPurge"
  /\ parameters' = [case |-> 0, token |-> 0, dump |-> d,
                      kind |-> NoCoverage]
  /\ UNCHANGED <<caseStatus, tokenState, tokenDump, dumpCase, blobState,
                 digestRecorded, validation, coverage, bundle, done, tokDone,
                 fingerprintMatches, custDone, caseDone, wiped>>

FinishPurgeI(d) ==
  /\ d \in Dumps
  /\ dumpPhase[d] = "deleting"
  /\ dumpPhase' = [dumpPhase EXCEPT ![d] = "deleted"]
  /\ blobState' = [blobState EXCEPT ![d] = "none"]
  /\ action_taken' = "FinishPurge"
  /\ parameters' = [case |-> 0, token |-> 0, dump |-> d,
                      kind |-> NoCoverage]
  /\ UNCHANGED <<caseStatus, tokenState, tokenDump, dumpCase,
                 digestRecorded, validation, coverage, downloadable, bundle,
                 done, tokDone, fingerprintMatches, custDone, caseDone,
                 wiped>>

(* EXPORT: selection partitions non-absent dumps by phase; any mid-copy race
   (vanishing bytes under a concurrent purge) aborts the whole export, so a
   sealed bundle is byte-exact by construction. The snapshot fields capture
   exactly what the real tar bundle's ledger copy preserves. *)
ExportStart ==
     (* one transfer cycle per behavior: the wiped target never exports,
        because a second cycle would reset the import-progress tracking that
        doubles as case-presence on the target *)
  /\ ~wiped
  /\ bundle.status \in {"absent", "sealed", "failed",
                        "finished", "import-failed"}
  /\ bundle' = [status |-> "running",
                promised |-> {d \in Dumps: dumpPhase[d] = "available"},
                rejected |-> {d \in Dumps: dumpPhase[d] = "rejected"},
                deleted |-> {d \in Dumps: dumpPhase[d] = "deleted"},
                bad |-> 0,
                cstat |-> <<caseStatus[1], caseStatus[2]>>,
                gstate |-> <<tokenState[1], tokenState[2]>>,
                gdump |-> <<tokenDump[1], tokenDump[2]>>,
                dcase |-> <<dumpCase[1], dumpCase[2]>>,
                dcov |-> <<IF dumpPhase[1] = "deleted" THEN coverage[1]
                             ELSE NoCoverage,
                           IF dumpPhase[2] = "deleted" THEN coverage[2]
                             ELSE NoCoverage>>]
  /\ done' = {}
  /\ custDone' = {}
  /\ caseDone' = {}
  /\ tokDone' = {}
  /\ action_taken' = "ExportStart"
  /\ parameters' = [case |-> 0, token |-> 0, dump |-> 0,
                      kind |-> NoCoverage]
  /\ UNCHANGED <<caseStatus, tokenState, tokenDump, dumpPhase, dumpCase,
                 blobState, digestRecorded, validation, coverage,
                 downloadable, fingerprintMatches, wiped>>

ExportSeal ==
  /\ bundle.status = "running"
  /\ bundle' = [bundle EXCEPT !.status = "sealed"]
  /\ action_taken' = "ExportSeal"
  /\ parameters' = [case |-> 0, token |-> 0, dump |-> 0,
                      kind |-> NoCoverage]
  /\ UNCHANGED <<caseStatus, tokenState, tokenDump, dumpPhase, dumpCase,
                 blobState, digestRecorded, validation, coverage,
                 downloadable, done, tokDone, fingerprintMatches, custDone,
                 caseDone, wiped>>

ExportFail ==
  /\ bundle.status = "running"
  /\ bundle' = [bundle EXCEPT !.status = "failed"]
  /\ action_taken' = "ExportFail"
  /\ parameters' = [case |-> 0, token |-> 0, dump |-> 0,
                      kind |-> NoCoverage]
  /\ UNCHANGED <<caseStatus, tokenState, tokenDump, dumpPhase, dumpCase,
                 blobState, digestRecorded, validation, coverage,
                 downloadable, done, tokDone, fingerprintMatches, custDone,
                 caseDone, wiped>>

(* External tampering between seal and import: exactly one promised dump's
   bytes are flipped (the e2e journey-2 shape). *)
TamperBundle(d) ==
  /\ bundle.status = "sealed"
  /\ d \in bundle.promised
  /\ bundle' = [bundle EXCEPT !.bad = d]
  /\ action_taken' = "TamperBundle"
  /\ parameters' = [case |-> 0, token |-> 0, dump |-> d,
                      kind |-> NoCoverage]
  /\ UNCHANGED <<caseStatus, tokenState, tokenDump, dumpPhase, dumpCase,
                 blobState, digestRecorded, validation, coverage,
                 downloadable, done, tokDone, fingerprintMatches, custDone,
                 caseDone, wiped>>

DeleteBundle ==
  /\ bundle.status \in {"sealed", "failed", "finished", "import-failed"}
  /\ bundle' = NoBundle
     (* the done-sets are NOT reset: on the wiped target they double as
        imported-entity presence, which deleting the bundle file does not
        change; pre-wipe they are always empty anyway *)
  /\ action_taken' = "DeleteBundle"
  /\ parameters' = [case |-> 0, token |-> 0, dump |-> 0,
                      kind |-> NoCoverage]
  /\ UNCHANGED <<caseStatus, tokenState, tokenDump, dumpPhase, dumpCase,
                 blobState, digestRecorded, validation, coverage,
                 downloadable, fingerprintMatches, done, tokDone, custDone,
                 caseDone, wiped>>

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
  /\ wiped' = TRUE
  /\ action_taken' = "WipeInstance"
  /\ parameters' = [case |-> 0, token |-> 0, dump |-> 0,
                      kind |-> NoCoverage]
  /\ UNCHANGED <<fingerprintMatches, bundle>>

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
  /\ action_taken' = "ImportStart"
  /\ parameters' = [case |-> 0, token |-> 0, dump |-> 0,
                      kind |-> NoCoverage]
  /\ UNCHANGED <<caseStatus, tokenState, tokenDump, dumpPhase, dumpCase,
                 blobState, digestRecorded, validation, coverage,
                 downloadable, fingerprintMatches, wiped>>

(* Entity rows travel in dependency order: customers before cases before
   grants before dumps. The guards here are the ledger's FK checks.
   ImportCustomer's customer slot rides the generic `case` wire field: the
   parameters record shape is fixed by the base spec. *)
ImportCustomer(c) ==
  /\ bundle.status = "importing"
  /\ c \in Customers
  /\ c \notin custDone
  /\ custDone' = custDone \cup {c}
  /\ action_taken' = "ImportCustomer"
  /\ parameters' = [case |-> c, token |-> 0, dump |-> 0,
                      kind |-> NoCoverage]
  /\ UNCHANGED <<caseStatus, tokenState, tokenDump, dumpPhase, dumpCase,
                 blobState, digestRecorded, validation, coverage,
                 downloadable, fingerprintMatches, bundle, caseDone, done,
                 tokDone, wiped>>

(* The imported case lands with its exported status (the real ImportCase
   preserves the source row's status column). *)
ImportCase(c) ==
  /\ bundle.status = "importing"
  /\ c \in Cases
  /\ c \notin caseDone
  /\ CaseCustomer[c] \in custDone        (* FK: the customer row exists *)
  /\ caseStatus' = [caseStatus EXCEPT ![c] = bundle.cstat[c]]
  /\ caseDone' = caseDone \cup {c}
  /\ action_taken' = "ImportCase"
  /\ parameters' = [case |-> c, token |-> 0, dump |-> 0,
                      kind |-> NoCoverage]
  /\ UNCHANGED <<tokenState, tokenDump, dumpPhase, dumpCase, blobState,
                 digestRecorded, validation, coverage, downloadable,
                 fingerprintMatches, bundle, custDone, done, tokDone, wiped>>

(* Grant import replays the exported row: the bundle only carries grants that
   existed at export (gstate[t] /= "unused"), the source state is preserved,
   and the consumed-by link lands verbatim -- dangling when the dump was
   skipped, exactly like the real consumed_by_dump_id column. The grant-key
   fingerprint policy is the single exception: a grant exported under a
   different key must never become usable, so a still-"issued" grant lands
   directly in the terminal "revoked" state. *)
ImportTokens(t) ==
  /\ bundle.status = "importing"
  /\ t \in Tokens
  /\ t \notin tokDone
  /\ bundle.gstate[t] /= "unused"
  /\ TokenCase[t] \in caseDone           (* FK: the case row exists *)
  /\ tokenState' = [tokenState EXCEPT ![t] =
       IF ~fingerprintMatches /\ bundle.gstate[t] = "issued"
         THEN "revoked" ELSE bundle.gstate[t]]
  /\ tokenDump' = [tokenDump EXCEPT ![t] = bundle.gdump[t]]
  /\ tokDone' = tokDone \cup {t}
  /\ action_taken' = "ImportTokens"
  /\ parameters' = [case |-> 0, token |-> t, dump |-> 0,
                      kind |-> NoCoverage]
  /\ UNCHANGED <<caseStatus, dumpPhase, dumpCase, blobState, digestRecorded,
                 validation, coverage, downloadable, bundle, done,
                 fingerprintMatches, custDone, caseDone, wiped>>

(* Verified bytes: staged and hashed to match the manifest, the row is
   created sealed/staging exactly like a sealed upload, then the shared
   PromoteI/QuarantineI/AcceptI path applies. The imported dump always lands
   in its exported case (dcase[d]); the trace's case input must agree. *)
ImportDumpOk(d, c) ==
  /\ bundle.status = "importing"
  /\ d \in bundle.promised
  /\ bundle.bad /= d
  /\ c \in Cases
  /\ c \in caseDone             (* FK: the case row exists *)
  /\ c = bundle.dcase[d]        (* the manifest fixes the association *)
  /\ dumpPhase[d] = "absent"
  /\ dumpCase[d] = NoCase
  /\ dumpPhase' = [dumpPhase EXCEPT ![d] = "sealed"]
  /\ blobState' = [blobState EXCEPT ![d] = "staging"]
  /\ dumpCase' = [dumpCase EXCEPT ![d] = c]
  /\ digestRecorded' = digestRecorded \cup {d}
  /\ done' = done \cup {d}
  /\ action_taken' = "ImportDumpOk"
  /\ parameters' = [case |-> c, token |-> 0, dump |-> d,
                      kind |-> NoCoverage]
  /\ UNCHANGED <<caseStatus, tokenState, tokenDump, validation, coverage,
                 downloadable, bundle, tokDone, fingerprintMatches, custDone,
                 caseDone, wiped>>

(* SHA-256/size mismatch (including the tampered dump): rejected tombstone,
   no bytes, never downloadable -- import.ts mismatchTombstone. The real row
   keeps the manifest's declared sha256, so the digest stays recorded. *)
ImportDumpReject(d, c) ==
  /\ bundle.status = "importing"
  /\ d = bundle.bad
  /\ d \in bundle.promised
  /\ c \in Cases
  /\ c \in caseDone             (* FK: the case row exists *)
  /\ c = bundle.dcase[d]
  /\ dumpPhase[d] = "absent"
  /\ dumpCase[d] = NoCase
  /\ dumpPhase' = [dumpPhase EXCEPT ![d] = "rejected"]
  /\ blobState' = [blobState EXCEPT ![d] = "none"]
  /\ dumpCase' = [dumpCase EXCEPT ![d] = c]
  /\ digestRecorded' = digestRecorded \cup {d}
  /\ validation' = [validation EXCEPT ![d] = "transfer-failed"]
  /\ done' = done \cup {d}
  /\ action_taken' = "ImportDumpReject"
  /\ parameters' = [case |-> c, token |-> 0, dump |-> d,
                      kind |-> NoCoverage]
  /\ UNCHANGED <<caseStatus, tokenState, tokenDump, coverage, downloadable,
                 bundle, tokDone, fingerprintMatches, custDone, caseDone,
                 wiped>>

(* Exported tombstones: metadata only, blobState none. The real tombstone row
   preserves the source validation/coverage/sha256 columns. A rejected source
   dump always has validation "invalid" and no coverage; a deleted source
   dump carries the evidence it had when deleted: coverage dcov[d]
   (NoCoverage unless it was deleted from "available") and validation "valid"
   exactly when a coverage kind was recorded. *)
ImportDumpTombR(d, c) ==
  /\ bundle.status = "importing"
  /\ d \in bundle.rejected
  /\ c \in Cases
  /\ c \in caseDone             (* FK: the case row exists *)
  /\ c = bundle.dcase[d]
  /\ dumpPhase[d] = "absent"
  /\ dumpCase[d] = NoCase
  /\ dumpPhase' = [dumpPhase EXCEPT ![d] = "rejected"]
  /\ blobState' = [blobState EXCEPT ![d] = "none"]
  /\ dumpCase' = [dumpCase EXCEPT ![d] = c]
  /\ digestRecorded' = digestRecorded \cup {d}
  /\ validation' = [validation EXCEPT ![d] = "invalid"]
  /\ done' = done \cup {d}
  /\ action_taken' = "ImportDumpTombR"
  /\ parameters' = [case |-> c, token |-> 0, dump |-> d,
                      kind |-> NoCoverage]
  /\ UNCHANGED <<caseStatus, tokenState, tokenDump, coverage, downloadable,
                 bundle, tokDone, fingerprintMatches, custDone, caseDone,
                 wiped>>

ImportDumpTombD(d, c) ==
  /\ bundle.status = "importing"
  /\ d \in bundle.deleted
  /\ c \in Cases
  /\ c \in caseDone             (* FK: the case row exists *)
  /\ c = bundle.dcase[d]
  /\ dumpPhase[d] = "absent"
  /\ dumpCase[d] = NoCase
  /\ dumpPhase' = [dumpPhase EXCEPT ![d] = "deleted"]
  /\ blobState' = [blobState EXCEPT ![d] = "none"]
  /\ dumpCase' = [dumpCase EXCEPT ![d] = c]
  /\ digestRecorded' = digestRecorded \cup {d}
  /\ validation' = [validation EXCEPT ![d] =
       IF bundle.dcov[d] = NoCoverage THEN "invalid" ELSE "valid"]
  /\ coverage' = [coverage EXCEPT ![d] = bundle.dcov[d]]
  /\ done' = done \cup {d}
  /\ action_taken' = "ImportDumpTombD"
  /\ parameters' = [case |-> c, token |-> 0, dump |-> d,
                      kind |-> NoCoverage]
  /\ UNCHANGED <<caseStatus, tokenState, tokenDump, downloadable, bundle,
                 tokDone, fingerprintMatches, custDone, caseDone, wiped>>

(* FinishImport requires every declared dump disposed of and every exported
   grant row imported; it audits only. *)
ImportFinish ==
  /\ bundle.status = "importing"
  /\ (bundle.promised \cup bundle.rejected \cup bundle.deleted) \subseteq done
  /\ custDone = Customers
  /\ caseDone = Cases
  /\ tokDone = {t \in Tokens: bundle.gstate[t] /= "unused"}
  /\ bundle' = [bundle EXCEPT !.status = "finished"]
  /\ action_taken' = "ImportFinish"
  /\ parameters' = [case |-> 0, token |-> 0, dump |-> 0,
                      kind |-> NoCoverage]
  /\ UNCHANGED <<caseStatus, tokenState, tokenDump, dumpPhase, dumpCase,
                 blobState, digestRecorded, validation, coverage,
                 downloadable, done, tokDone, fingerprintMatches, custDone,
                 caseDone, wiped>>

(* Any hard failure after BeginImport: partial state persists, no
   FinishImport marker (importBundle's catch path). *)
ImportHardFail ==
  /\ bundle.status = "importing"
  /\ bundle' = [bundle EXCEPT !.status = "import-failed"]
  /\ action_taken' = "ImportHardFail"
  /\ parameters' = [case |-> 0, token |-> 0, dump |-> 0,
                      kind |-> NoCoverage]
  /\ UNCHANGED <<caseStatus, tokenState, tokenDump, dumpPhase, dumpCase,
                 blobState, digestRecorded, validation, coverage,
                 downloadable, done, tokDone, fingerprintMatches, custDone,
                 caseDone, wiped>>

TransferNext ==
  \/ \E t \in Tokens: IssueTokenI(t)
  \/ \E t \in Tokens, d \in Dumps: BeginUploadI(t, d)
  \/ \E d \in Dumps: SealUploadI(d)
  \/ \E d \in Dumps: PromoteI(d)
  \/ \E d \in Dumps: QuarantineI(d)
  \/ \E d \in Dumps, kind \in CoverageKinds: AcceptI(d, kind)
  \/ \E d \in Dumps: RejectI(d)
  \/ \E d \in Dumps: BeginPurgeI(d)
  \/ \E d \in Dumps: FinishPurgeI(d)
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
             action_taken, parameters, wiped, fingerprintMatches, bundle,
             custDone, caseDone, done, tokDone>>

TransferSpec == TransferInit /\ [][TransferNext]_allVars

(* ---------------------------------------------------------------------------
 * Transfer safety, checked TOGETHER with the base lifecycle invariants: the
 * base guarantees (AvailableHasEvidence, NoPrematureBlob, DeletedHasNoBlob,
 * ...) hold for dumps that entered the ledger through import, because import
 * reuses the same lifecycle actions. The base TypeOK and TokenIntegrity are
 * replaced by the transfer-aware versions below: the wire label universe is
 * wider here, and a consumed grant may dangle onto a skipped dump.
 * ------------------------------------------------------------------------- *)
BundleTypeOK ==
  /\ bundle.status \in BundleStatuses
  /\ bundle.promised \subseteq Dumps
  /\ bundle.rejected \subseteq Dumps
  /\ bundle.deleted \subseteq Dumps
  /\ bundle.bad \in Dumps \cup {0}
  /\ \A c \in Cases: bundle.cstat[c] \in CaseStatuses
  /\ \A t \in Tokens: bundle.gstate[t] \in TokenStates
  /\ \A t \in Tokens: bundle.gdump[t] \in Dumps \cup {NoDump}
  /\ \A d \in Dumps: bundle.dcase[d] \in Cases \cup {NoCase}
  /\ \A d \in Dumps: bundle.dcov[d] \in CoverageKinds \cup {NoCoverage}
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
     exported deleted  -> deleted tombstone, no bytes
   The landing is permanent except for retention: a rejected tombstone may
   later be purged (rejected -> deleting -> deleted, all still
   non-downloadable and byteless), which the lifecycle invariants check
   separately. *)
ImportDisposition ==
  \A d \in done:
    /\ (d = bundle.bad) =>
         dumpPhase[d] \in {"rejected", "deleting", "deleted"}
    /\ (d \in bundle.rejected) =>
         dumpPhase[d] \in {"rejected", "deleting", "deleted"}
    /\ (d \in bundle.deleted) => dumpPhase[d] = "deleted"
    /\ (d \in bundle.rejected \cup bundle.deleted) =>
         /\ blobState[d] = "none"
         /\ d \notin downloadable

(* Grant-key fingerprint policy: under a mismatched key no imported grant is
   ever issuable (a still-"issued" grant lands directly in "revoked"; grants
   in every other state are preserved). *)
FingerprintPolicy ==
  (~fingerprintMatches) =>
    \A t \in tokDone: tokenState[t] /= "issued"

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

(* The wire annotation universe of this module: the base lifecycle labels the
   lite actions reuse, plus the transfer-specific labels. The base spec's
   TypeOK deliberately keeps the base-only set and is not checked here. *)
TransferActionLabels ==
  {"Init", "IssueToken", "BeginUpload", "SealUpload", "PromoteObject",
   "MarkQuarantined", "AcceptDump", "RejectDump", "BeginPurge",
   "FinishPurge", "ExportStart", "ExportSeal", "ExportFail",
   "TamperBundle", "DeleteBundle", "WipeInstance", "ImportStart",
   "ImportCustomer", "ImportCase", "ImportTokens", "ImportDumpOk",
   "ImportDumpReject", "ImportDumpTombR", "ImportDumpTombD", "ImportFinish",
   "ImportHardFail"}

TransferAnnotationOK ==
  /\ action_taken \in TransferActionLabels
  /\ parameters \in [case: Cases \cup {0},
                       token: Tokens \cup {0},
                       dump: Dumps \cup {0},
                       kind: CoverageKinds \cup {NoCoverage}]

(* The base TypeOK structural domains, plus this module's annotation
   universe. Keep the structural conjuncts mirrored with the base TypeOK. *)
TransferTypeOK ==
  /\ Len(caseStatus) = Cardinality(Cases)
  /\ \A c \in Cases: caseStatus[c] \in CaseStatuses
  /\ Len(tokenState) = Cardinality(Tokens)
  /\ \A t \in Tokens: tokenState[t] \in TokenStates
  /\ Len(tokenDump) = Cardinality(Tokens)
  /\ \A t \in Tokens: tokenDump[t] \in Dumps \cup {NoDump}
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
  /\ TransferAnnotationOK

(* The base TokenIntegrity with one transfer-aware relaxation: a consumed
   grant may reference a dump that was skipped at export (left in-flight);
   that dump never materializes on the target, so the association clause only
   applies when the dump is present. Uniqueness is unchanged. *)
TransferTokenIntegrity ==
  /\ \A t \in Tokens:
       (tokenState[t] = "consumed") <=> (tokenDump[t] \in Dumps)
  /\ \A t \in Tokens:
       (tokenDump[t] \in Dumps /\ dumpPhase[tokenDump[t]] /= "absent") =>
         dumpCase[tokenDump[t]] = TokenCase[t]
  /\ \A t1, t2 \in Tokens:
       (tokenDump[t1] = tokenDump[t2] /\ tokenDump[t1] \in Dumps) => t1 = t2

(* Combined check target: the base lifecycle invariants (with the
   transfer-aware type/token replacements) must hold for dumps and grants
   that entered through import as well. *)
TransferSafetyFull ==
  /\ TransferTypeOK
  /\ AssociationIntegrity
  /\ TransferTokenIntegrity
  /\ ClosedCaseHasNoIssuedGrant
  /\ AvailableHasEvidence
  /\ SealedAndQuarantinedHaveEvidence
  /\ NoPrematureBlob
  /\ RejectedIsNotDownloadable
  /\ DeletingIsNotDownloadable
  /\ DeletedHasNoBlob
  /\ TransferSafety

=============================================================================
