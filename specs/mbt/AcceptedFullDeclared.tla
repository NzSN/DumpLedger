------------------------ MODULE AcceptedFullDeclared -------------------------
EXTENDS DumpLedger

WitnessNotReached ==
  ~(dumpPhase[1] = "deleted" /\ coverage[1] = "full-memory-declared" /\ dumpToken[1] = 1)

=============================================================================
