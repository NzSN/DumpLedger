--------------------------- MODULE CaseWorkflow -------------------------------
EXTENDS DumpLedger

\* Drive one full operator case workflow: start, wait, resume, resolve, then
\* issue a grant and close, so the model revokes the issued grant atomically.
\* Guards on the previous action label keep the generated witness trace
\* deterministic even where the base Next relation branches (for example, an
\* investigating case may either wait for the customer or resolve).
WitnessNext ==
  \/ /\ action_taken = "Init"
     /\ StartInvestigation(1)
  \/ /\ action_taken = "StartInvestigation"
     /\ WaitForCustomer(1)
  \/ /\ action_taken = "WaitForCustomer"
     /\ ResumeInvestigation(1)
  \/ /\ action_taken = "ResumeInvestigation"
     /\ tokenState = <<"unused", "unused">>
     /\ ResolveCase(1)
  \/ /\ action_taken = "ResolveCase"
     /\ tokenState = <<"unused", "unused">>
     /\ IssueToken(1)
  \/ /\ action_taken = "IssueToken"
     /\ CloseCase(1)

WitnessNotReached ==
  ~(caseStatus = <<"closed", "new">> /\
    tokenState = <<"revoked", "unused">> /\
    action_taken = "CloseCase")

=============================================================================
