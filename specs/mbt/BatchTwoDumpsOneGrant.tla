----------------------- MODULE BatchTwoDumpsOneGrant -------------------------
EXTENDS DumpLedger

\* Batch upload witness (docs/batch-upload-design.md): one two-slot grant
\* delivers both dumps and is consumed exactly at its slot bound.
WitnessNotReached ==
  ~(dumpToken = <<2, 2>> /\ tokenState[2] = "consumed" /\
    dumpPhase[1] = "receiving" /\ dumpPhase[2] = "receiving")

=============================================================================
