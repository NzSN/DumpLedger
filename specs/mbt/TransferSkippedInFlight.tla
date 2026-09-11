----------------------- MODULE TransferSkippedInFlight ----------------------
(* Pinned skip path: dump 1 is still receiving at export (left behind), so
   its consumed grant imports with the consumed-by link dangling, while the
   available dump 2 restores normally. *)
EXTENDS DumpLedgerTransfer

WitnessInit == TransferInit /\ fingerprintMatches

WitnessNext ==
  \/ /\ action_taken = "Init"
     /\ IssueTokenI(1)
  \/ /\ action_taken = "IssueToken"
     /\ tokenState = <<"issued", "unused">>
     /\ BeginUploadI(1, 1)
  \/ /\ action_taken = "BeginUpload"
     /\ IssueTokenI(2)
  \/ /\ action_taken = "IssueToken"
     /\ tokenState = <<"consumed", "issued">>
     /\ BeginUploadI(2, 2)
  \/ /\ action_taken = "BeginUpload"
     /\ tokenDump = <<1, 2>>
     /\ SealUploadI(2)
  \/ /\ action_taken = "SealUpload"
     /\ PromoteI(2)
  \/ /\ action_taken = "PromoteObject"
     /\ QuarantineI(2)
  \/ /\ action_taken = "MarkQuarantined"
     /\ AcceptI(2, "full-memory-declared")
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
     /\ tokDone = {1}
     /\ ImportTokens(2)
  \/ /\ action_taken = "ImportTokens"
     /\ tokDone = {1, 2}
     /\ ImportDumpOk(2, 2)
  \/ /\ action_taken = "ImportDumpOk"
     /\ PromoteI(2)
  \/ /\ action_taken = "PromoteObject"
     /\ dumpPhase = <<"absent", "sealed">>
     /\ QuarantineI(2)
  \/ /\ action_taken = "MarkQuarantined"
     /\ dumpPhase = <<"absent", "quarantined">>
     /\ AcceptI(2, "full-memory-declared")
  \/ /\ action_taken = "AcceptDump"
     /\ dumpPhase = <<"absent", "available">>
     /\ ImportFinish

WitnessNotReached ==
  ~(bundle.status = "finished" /\ tokenDump = <<1, 2>>
    /\ dumpPhase = <<"absent", "available">>
    /\ action_taken = "ImportFinish")

=============================================================================
