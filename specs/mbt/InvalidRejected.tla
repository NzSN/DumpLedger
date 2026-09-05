--------------------------- MODULE InvalidRejected ---------------------------
EXTENDS DumpLedger

WitnessNotReached ==
  ~(dumpPhase[1] = "deleted" /\ validation[1] = "invalid" /\ tokenDump[2] = 1)

=============================================================================
