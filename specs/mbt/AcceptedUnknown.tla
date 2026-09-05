--------------------------- MODULE AcceptedUnknown ---------------------------
EXTENDS DumpLedger

WitnessNotReached ==
  ~(dumpPhase[1] = "deleted" /\ coverage[1] = "unknown" /\ tokenDump[1] = 1)

=============================================================================
