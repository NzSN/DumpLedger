----------------------- MODULE TransferImportHardFail -----------------------
(* Pinned import-crash path: the restore dies mid-import with the declared
   dump still pending, so partial entity state persists and no FinishImport
   marker exists. *)
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
     /\ ImportHardFail

WitnessNotReached ==
  ~(bundle.status = "import-failed" /\ action_taken = "ImportHardFail"
    /\ dumpPhase = <<"absent", "absent">> /\ digestRecorded = {}
    /\ tokenState = <<"consumed", "unused">>)

=============================================================================
