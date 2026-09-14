--------------------------- MODULE InvalidRejected ---------------------------
EXTENDS DumpLedger

WitnessNotReached ==
  ~(dumpPhase[1] = "deleted" /\ validation[1] = "invalid" /\ dumpToken[1] = 2)

=============================================================================
