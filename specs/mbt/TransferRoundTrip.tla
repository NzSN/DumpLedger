------------------------- MODULE TransferRoundTrip --------------------------
(* Pinned happy path: upload a dump to available, issue a second grant,
   export, wipe, and restore. The imported dump re-earns available through
   quarantine; the imported grants land in their exported states
   (consumed + issued) under a matching grant-key fingerprint. *)
EXTENDS DumpLedgerTransfer

WitnessInit == TransferInit /\ fingerprintMatches

WitnessNext ==
  \/ /\ action_taken = "Init"
     /\ IssueTokenI(1)
  \/ /\ action_taken = "IssueToken"
     /\ tokenState = <<"issued", "unused">>
     /\ BeginUploadI(1, 1)
  \/ /\ action_taken = "BeginUpload"
     /\ SealUploadI(1)
  \/ /\ action_taken = "SealUpload"
     /\ dumpPhase = <<"sealed", "absent">>
     /\ PromoteI(1)
  \/ /\ action_taken = "PromoteObject"
     /\ dumpPhase = <<"sealed", "absent">>
     /\ QuarantineI(1)
  \/ /\ action_taken = "MarkQuarantined"
     /\ AcceptI(1, "partial")
  \/ /\ action_taken = "AcceptDump"
     /\ IssueTokenI(2)
  \/ /\ action_taken = "IssueToken"
     /\ tokenState = <<"consumed", "issued">>
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
     /\ ImportDumpOk(1, 1)
  \/ /\ action_taken = "ImportDumpOk"
     /\ PromoteI(1)
  \/ /\ action_taken = "PromoteObject"
     /\ dumpPhase = <<"sealed", "absent">>
     /\ QuarantineI(1)
  \/ /\ action_taken = "MarkQuarantined"
     /\ dumpPhase = <<"quarantined", "absent">>
     /\ AcceptI(1, "partial")
  \/ /\ action_taken = "AcceptDump"
     /\ dumpPhase = <<"available", "absent">>
     /\ wiped
     /\ ImportFinish

WitnessNotReached ==
  ~(bundle.status = "finished" /\ dumpPhase = <<"available", "absent">>
    /\ tokenState = <<"consumed", "issued">>
    /\ action_taken = "ImportFinish")

=============================================================================
