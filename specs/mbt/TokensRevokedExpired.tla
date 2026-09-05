------------------------ MODULE TokensRevokedExpired -------------------------
EXTENDS DumpLedger

\* Fix the independent grant actions into one reproducible witness order. This
\* constrains trace generation only; the base model continues to check Next.
WitnessNext ==
  \/ /\ tokenState = <<"unused", "unused">>
     /\ IssueToken(2)
  \/ /\ tokenState = <<"unused", "issued">>
     /\ IssueToken(1)
  \/ /\ tokenState = <<"issued", "issued">>
     /\ ExpireToken(2)
  \/ /\ tokenState = <<"issued", "expired">>
     /\ RevokeToken(1)

WitnessNotReached ==
  ~(tokenState[1] = "revoked" /\ tokenState[2] = "expired" /\
    action_taken = "RevokeToken")

=============================================================================
