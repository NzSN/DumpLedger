--------------------------- MODULE AcceptedPartial ---------------------------
EXTENDS DumpLedger

WitnessNotReached ==
  ~(dumpPhase[1] = "deleted" /\ coverage[1] = "partial" /\ dumpToken[1] = 1)

=============================================================================
