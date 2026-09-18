------------------------- MODULE TransferRoundTrip --------------------------
(* Pinned happy path: register two symbol identities, purge one, upload a
   dump to available, issue a second grant, export WITH the symbol flag,
   wipe, and restore. The imported dump re-earns available through
   quarantine; the imported grants land in their exported states
   (consumed + issued) under a matching grant-key fingerprint; and the
   carried symbol identity (identity 1 -- identity 2 was purged before the
   export) registers on the target. Dump slot 1 references identities 1 and
   2 (DumpSymbols), so the carried set exercises both the registered join
   and the include-once selection. *)
EXTENDS DumpLedgerTransfer

WitnessInit == TransferInit /\ fingerprintMatches

WitnessNext ==
  \/ /\ action_taken = "Init"
     /\ IngestSymbolI(1)
  \/ /\ action_taken = "IngestSymbol"
     /\ symbolRegistered = {1}
     /\ IngestSymbolI(2)
  \/ /\ action_taken = "IngestSymbol"
     /\ symbolRegistered = {1, 2}
     /\ PurgeSymbolI(2)
  \/ /\ action_taken = "PurgeSymbol"
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
     /\ ExportStartWithSymbols
  \/ /\ action_taken = "ExportStartWithSymbols"
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
     /\ ImportSymbols
  \/ /\ action_taken = "ImportSymbols"
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
    /\ symbolRegistered = {1}
    /\ action_taken = "ImportFinish")

=============================================================================
