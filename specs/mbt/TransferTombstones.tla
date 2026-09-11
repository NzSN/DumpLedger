------------------------- MODULE TransferTombstones -------------------------
(* Pinned tombstone path: dump 1 is purged after acceptance (deleted with
   coverage and validation "valid" recorded), dump 2 is rejected at
   quarantine; the export carries both as metadata tombstones and the import
   replays their recorded evidence verbatim. *)
EXTENDS DumpLedgerTransfer

WitnessInit == TransferInit /\ fingerprintMatches

WitnessNext ==
  \/ /\ action_taken = "Init"
     /\ IssueTokenI(1)
  \/ /\ action_taken = "IssueToken"
     /\ tokenState = <<"issued", "unused">>
     /\ BeginUploadI(1, 1)
  \/ /\ action_taken = "BeginUpload"
     /\ tokenDump = <<1, 0>>
     /\ SealUploadI(1)
  \/ /\ action_taken = "SealUpload"
     /\ dumpPhase = <<"sealed", "absent">>
     /\ PromoteI(1)
  \/ /\ action_taken = "PromoteObject"
     /\ dumpPhase = <<"sealed", "absent">>
     /\ QuarantineI(1)
  \/ /\ action_taken = "MarkQuarantined"
     /\ dumpPhase = <<"quarantined", "absent">>
     /\ AcceptI(1, "partial")
  \/ /\ action_taken = "AcceptDump"
     /\ BeginPurgeI(1)
  \/ /\ action_taken = "BeginPurge"
     /\ FinishPurgeI(1)
  \/ /\ action_taken = "FinishPurge"
     /\ IssueTokenI(2)
  \/ /\ action_taken = "IssueToken"
     /\ tokenState = <<"consumed", "issued">>
     /\ BeginUploadI(2, 2)
  \/ /\ action_taken = "BeginUpload"
     /\ tokenDump = <<1, 2>>
     /\ SealUploadI(2)
  \/ /\ action_taken = "SealUpload"
     /\ dumpPhase = <<"deleted", "sealed">>
     /\ PromoteI(2)
  \/ /\ action_taken = "PromoteObject"
     /\ dumpPhase = <<"deleted", "sealed">>
     /\ QuarantineI(2)
  \/ /\ action_taken = "MarkQuarantined"
     /\ dumpPhase = <<"deleted", "quarantined">>
     /\ RejectI(2)
  \/ /\ action_taken = "RejectDump"
     /\ ExportStart
  \/ /\ action_taken = "ExportStart"
     /\ ExportSeal
  \/ /\ action_taken = "ExportSeal"
     /\ WipeInstance
  \/ /\ action_taken = "WipeInstance"
     /\ ImportStart
  \/ /\ action_taken = "ImportStart"
     /\ ImportCustomer(1)
  \/ /\ action_taken = "ImportCustomer"
     /\ custDone = {1}
     /\ ImportCustomer(2)
  \/ /\ action_taken = "ImportCustomer"
     /\ custDone = {1, 2}
     /\ ImportCase(1)
  \/ /\ action_taken = "ImportCase"
     /\ caseDone = {1}
     /\ ImportCase(2)
  \/ /\ action_taken = "ImportCase"
     /\ caseDone = {1, 2}
     /\ ImportTokens(1)
  \/ /\ action_taken = "ImportTokens"
     /\ tokDone = {1}
     /\ ImportTokens(2)
  \/ /\ action_taken = "ImportTokens"
     /\ tokDone = {1, 2}
     /\ ImportDumpTombD(1, 1)
  \/ /\ action_taken = "ImportDumpTombD"
     /\ ImportDumpTombR(2, 2)
  \/ /\ action_taken = "ImportDumpTombR"
     /\ ImportFinish

WitnessNotReached ==
  ~(bundle.status = "finished" /\ dumpPhase = <<"deleted", "rejected">>
    /\ coverage = <<"partial", "unclassified">>
    /\ validation = <<"valid", "invalid">>
    /\ action_taken = "ImportFinish")

=============================================================================
