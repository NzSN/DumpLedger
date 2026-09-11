----------------------- MODULE TransferExportFailDelete ---------------------
(* Pinned export-failure path: the streaming copy aborts mid-export (the
   race/fault policy), leaving the ledger untouched; the operator then
   deletes the failed bundle record. *)
EXTENDS DumpLedgerTransfer

WitnessInit == TransferInit /\ fingerprintMatches

WitnessNext ==
  \/ /\ action_taken = "Init"
     /\ IssueTokenI(1)
  \/ /\ action_taken = "IssueToken"
     /\ BeginUploadI(1, 1)
  \/ /\ action_taken = "BeginUpload"
     /\ SealUploadI(1)
  \/ /\ action_taken = "SealUpload"
     /\ PromoteI(1)
  \/ /\ action_taken = "PromoteObject"
     /\ QuarantineI(1)
  \/ /\ action_taken = "MarkQuarantined"
     /\ AcceptI(1, "partial")
  \/ /\ action_taken = "AcceptDump"
     /\ ExportStart
  \/ /\ action_taken = "ExportStart"
     /\ ExportFail
  \/ /\ action_taken = "ExportFail"
     /\ DeleteBundle

WitnessNotReached ==
  ~(bundle.status = "absent" /\ action_taken = "DeleteBundle"
    /\ dumpPhase = <<"available", "absent">>)

=============================================================================
