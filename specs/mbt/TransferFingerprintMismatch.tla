--------------------- MODULE TransferFingerprintMismatch --------------------
(* Pinned policy path: the importing instance's grant key differs from the
   bundle's fingerprint, so a grant that was still "issued" at export lands
   revoked, while the consumed grant (and its dump) is preserved. *)
EXTENDS DumpLedgerTransfer

WitnessInit == TransferInit /\ ~fingerprintMatches

WitnessNext ==
  \/ /\ action_taken = "Init"
     /\ IssueTokenI(1)
  \/ /\ action_taken = "IssueToken"
     /\ tokenState = <<"issued", "unused">>
     /\ IssueTokenI(2)
  \/ /\ action_taken = "IssueToken"
     /\ tokenState = <<"issued", "issued">>
     /\ BeginUploadI(2, 2)
  \/ /\ action_taken = "BeginUpload"
     /\ SealUploadI(2)
  \/ /\ action_taken = "SealUpload"
     /\ PromoteI(2)
  \/ /\ action_taken = "PromoteObject"
     /\ QuarantineI(2)
  \/ /\ action_taken = "MarkQuarantined"
     /\ AcceptI(2, "unknown")
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
     /\ AcceptI(2, "unknown")
  \/ /\ action_taken = "AcceptDump"
     /\ dumpPhase = <<"absent", "available">>
     /\ ImportFinish

WitnessNotReached ==
  ~(bundle.status = "finished" /\ tokenState = <<"revoked", "consumed">>
    /\ dumpPhase = <<"absent", "available">>
    /\ action_taken = "ImportFinish")

=============================================================================
