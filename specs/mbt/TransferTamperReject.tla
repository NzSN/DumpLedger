------------------------ MODULE TransferTamperReject ------------------------
(* Pinned tamper path: one byte flipped between seal and import; the tampered
   dump lands as a rejected transfer-failed tombstone, never available. *)
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
     /\ TamperBundle(1)
  \/ /\ action_taken = "TamperBundle"
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
     /\ ImportDumpReject(1, 1)
  \/ /\ action_taken = "ImportDumpReject"
     /\ ImportFinish

WitnessNotReached ==
  ~(bundle.status = "finished" /\ dumpPhase = <<"rejected", "absent">>
    /\ validation = <<"transfer-failed", "not-checked">>
    /\ action_taken = "ImportFinish")

=============================================================================
