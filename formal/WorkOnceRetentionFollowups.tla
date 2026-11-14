----------------------- MODULE WorkOnceRetentionFollowups -----------------------
EXTENDS Naturals

Kinds == {"none", "forever", "finite"}
Phases == {"running", "terminal"}

VARIABLES phase, capable, outbox, receipt, legacy, rejected, replayed, delivered,
          lastCommitKind, lastCommitCapable, lastDeliveryKind, lastDeliveryCapable

vars == <<phase, capable, outbox, receipt, legacy, rejected, replayed, delivered,
          lastCommitKind, lastCommitCapable, lastDeliveryKind, lastDeliveryCapable>>

RunningInit ==
  /\ phase = "running"
  /\ capable \in BOOLEAN
  /\ outbox = "none"
  /\ receipt = FALSE
  /\ legacy = FALSE
  /\ rejected = FALSE
  /\ replayed = FALSE
  /\ delivered = FALSE
  /\ lastCommitKind = "none"
  /\ lastCommitCapable = FALSE
  /\ lastDeliveryKind = "none"
  /\ lastDeliveryCapable = FALSE

\* An older version may already have committed an unsupported finite child.
LegacyInit ==
  /\ phase = "terminal"
  /\ capable = FALSE
  /\ outbox = "finite"
  /\ receipt = TRUE
  /\ legacy = TRUE
  /\ rejected = FALSE
  /\ replayed = FALSE
  /\ delivered = FALSE
  /\ lastCommitKind = "none"
  /\ lastCommitCapable = FALSE
  /\ lastDeliveryKind = "none"
  /\ lastDeliveryCapable = FALSE

Init == RunningInit \/ LegacyInit

\* The capability check is applied before the parent can become terminal.
AcceptFinite ==
  /\ phase = "running"
  /\ capable
  /\ phase' = "terminal"
  /\ outbox' = "finite"
  /\ receipt' = TRUE
  /\ rejected' = FALSE
  /\ lastCommitKind' = "finite"
  /\ lastCommitCapable' = capable
  /\ UNCHANGED <<capable, legacy, replayed, delivered, lastDeliveryKind, lastDeliveryCapable>>

RejectFinite ==
  /\ phase = "running"
  /\ ~capable
  /\ rejected' = TRUE
  /\ UNCHANGED <<phase, capable, outbox, receipt, legacy, replayed, delivered,
                  lastCommitKind, lastCommitCapable, lastDeliveryKind, lastDeliveryCapable>>

AttemptFinite == AcceptFinite \/ RejectFinite

AttemptOther ==
  /\ phase = "running"
  /\ \E kind \in {"none", "forever"} :
       /\ phase' = "terminal"
       /\ outbox' = kind
       /\ receipt' = TRUE
       /\ rejected' = FALSE
       /\ lastCommitKind' = kind
       /\ lastCommitCapable' = capable
  /\ UNCHANGED <<capable, legacy, replayed, delivered, lastDeliveryKind, lastDeliveryCapable>>

\* Already committed receipts can replay even if a later deployment lost the capability.
Replay ==
  /\ phase = "terminal"
  /\ receipt
  /\ ~replayed
  /\ replayed' = TRUE
  /\ UNCHANGED <<phase, capable, outbox, receipt, legacy, rejected, delivered,
                  lastCommitKind, lastCommitCapable, lastDeliveryKind, lastDeliveryCapable>>

Upgrade ==
  /\ ~capable
  /\ capable' = TRUE
  /\ UNCHANGED <<phase, outbox, receipt, legacy, rejected, replayed, delivered,
                  lastCommitKind, lastCommitCapable, lastDeliveryKind, lastDeliveryCapable>>

Downgrade ==
  /\ capable
  /\ capable' = FALSE
  /\ UNCHANGED <<phase, outbox, receipt, legacy, rejected, replayed, delivered,
                  lastCommitKind, lastCommitCapable, lastDeliveryKind, lastDeliveryCapable>>

\* A previous-version poison request is never dropped/reinterpreted. Once the
\* adapter supports deletion, dispatch inserts it and acknowledges the parent.
Dispatch ==
  /\ phase = "terminal"
  /\ outbox # "none"
  /\ (outbox # "finite" \/ capable)
  /\ lastDeliveryKind' = outbox
  /\ lastDeliveryCapable' = capable
  /\ outbox' = "none"
  /\ delivered' = TRUE
  /\ UNCHANGED <<phase, capable, receipt, legacy, rejected, replayed,
                  lastCommitKind, lastCommitCapable>>

Next == AttemptFinite \/ AttemptOther \/ Replay \/ Upgrade \/ Downgrade \/ Dispatch
Spec == Init /\ [][Next]_vars

FollowupTypeOK ==
  /\ phase \in Phases
  /\ capable \in BOOLEAN
  /\ outbox \in Kinds
  /\ receipt \in BOOLEAN
  /\ legacy \in BOOLEAN
  /\ rejected \in BOOLEAN
  /\ replayed \in BOOLEAN
  /\ delivered \in BOOLEAN
  /\ lastCommitKind \in Kinds
  /\ lastCommitCapable \in BOOLEAN
  /\ lastDeliveryKind \in Kinds
  /\ lastDeliveryCapable \in BOOLEAN

UnsupportedFiniteNeverCommitted ==
  lastCommitKind = "finite" => lastCommitCapable
UnsupportedFiniteNeverDispatched ==
  lastDeliveryKind = "finite" => lastDeliveryCapable
RejectedAttemptPreservesLease ==
  rejected => (phase = "running" /\ ~receipt /\ outbox = "none")
LegacyIntentNotSilentlyDiscarded ==
  (legacy /\ ~delivered) => outbox = "finite"

\* The only progress claim assumes an operator upgrades the adapter and that
\* dispatch is fairly run. Without the upgrade, a legacy poison row cannot drain.
FairRepairSpec == Spec /\ WF_vars(Upgrade) /\ SF_vars(Dispatch)
LegacyEventuallyDrains ==
  (legacy /\ outbox = "finite") ~> outbox = "none"
=============================================================================
