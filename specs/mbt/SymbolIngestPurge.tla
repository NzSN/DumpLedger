------------------------ MODULE SymbolIngestPurge ---------------------------
EXTENDS DumpLedger

\* Symbol store witness (docs/symbols-design.md): ingest is idempotent
\* (re-registering an identity changes nothing), several identities coexist,
\* and purge removes exactly one.
WitnessNext ==
  \/ /\ action_taken = "Init"
     /\ IngestSymbol(1)
  \/ /\ action_taken = "IngestSymbol"
     /\ symbolRegistered = {1}
     /\ IngestSymbol(1)
  \/ /\ action_taken = "IngestSymbol"
     /\ symbolRegistered = {1}
     /\ IngestSymbol(2)
  \/ /\ action_taken = "IngestSymbol"
     /\ symbolRegistered = {1, 2}
     /\ PurgeSymbol(1)

WitnessNotReached ==
  ~(symbolRegistered = {2} /\ action_taken = "PurgeSymbol")

=============================================================================
