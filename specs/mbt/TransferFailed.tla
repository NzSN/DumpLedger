--------------------------- MODULE TransferFailed ----------------------------
EXTENDS DumpLedger

WitnessNotReached ==
  ~(dumpPhase[1] = "deleted" /\ validation[1] = "transfer-failed" /\ tokenDump[1] = 1)

=============================================================================
