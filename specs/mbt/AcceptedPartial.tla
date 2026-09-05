--------------------------- MODULE AcceptedPartial ---------------------------
EXTENDS DumpLedger

WitnessNotReached ==
  ~(dumpPhase[1] = "deleted" /\ coverage[1] = "partial" /\ tokenDump[1] = 1)

=============================================================================
