--------------------------- MODULE RecordAnalysis -----------------------------
EXTENDS DumpLedger

\* Analysis write-back witness (docs/analyzer-integration-design.md, "Analysis
\* write-back"): an available dump records one analysis report, and the purge
\* cascade removes the report together with the bytes it describes. Guards on
\* the previous action label keep the generated witness trace deterministic
\* even where the base Next relation branches.
WitnessNext ==
  \/ /\ action_taken = "Init"
     /\ IssueToken(1)
  \/ /\ action_taken = "IssueToken"
     /\ BeginUpload(1, 1)
  \/ /\ action_taken = "BeginUpload"
     /\ SealUpload(1)
  \/ /\ action_taken = "SealUpload"
     /\ PromoteObject(1)
  \/ /\ action_taken = "PromoteObject"
     /\ MarkQuarantined(1)
  \/ /\ action_taken = "MarkQuarantined"
     /\ AcceptDump(1, "partial")
  \/ /\ action_taken = "AcceptDump"
     /\ RecordAnalysis(1)
  \/ /\ action_taken = "RecordAnalysis"
     /\ BeginPurge(1)
  \/ /\ action_taken = "BeginPurge"
     /\ FinishPurge(1)

WitnessNotReached ==
  ~(action_taken = "FinishPurge" /\
    analysisRecorded = {} /\
    dumpPhase = <<"deleted", "absent">>)

=============================================================================
