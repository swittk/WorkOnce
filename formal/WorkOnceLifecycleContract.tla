---------------------- MODULE WorkOnceLifecycleContract ----------------------
EXTENDS Naturals

LifecycleAdapterDomain == {"memory", "sqlite", "cas"}

LifecycleSampleOK(s) ==
  CASE s.kind = "revisionHistorySplit" ->
       /\ s.sameOldAbstraction /\ s.revisionsDiffer /\ s.historiesDiffer
       /\ s.sameFutureCommand /\ s.futureDiverges
    [] s.kind = "terminalReceipt" ->
       /\ s.outcomeKind \in {"succeed", "fail"}
       /\ s.terminalState = (IF s.outcomeKind = "succeed" THEN "succeeded" ELSE "failed")
       /\ s.receiptBound /\ s.replayExact /\ s.conflictExact /\ s.lateCancelNoop
       /\ s.resetGeneration /\ s.resetClearsReceipt /\ s.resetCounters
       /\ s.oldReplayStale /\ s.fenceMonotone
    [] s.kind = "cancelOrdering" ->
       /\ s.first \in {"cancel", "complete"} /\ s.cancelAccepted
       /\ s.finalState = (IF s.first = "cancel" THEN "cancelled" ELSE "succeeded")
       /\ s.completionRejected = (s.first = "cancel")
       /\ s.completionCause = (IF s.first = "cancel" THEN "stale_attempt" ELSE "none")
    [] s.kind = "leaseFenceCause" ->
       /\ s.exactBoundaryExpired /\ s.reclaimedFence /\ s.staleRenewCause /\ s.staleSettleCause
    [] s.kind = "generationCompetition" ->
       /\ s.exactlyOneReset /\ s.exactLoser /\ s.queuedOnce
    [] s.kind = "resetCheckRace" ->
       /\ s.resetKind \in {"retry", "rerun"}
       /\ s.checkOnce /\ s.winnerAdvanced /\ s.exactLateCause /\ s.noDoubleGeneration
    [] s.kind = "claimOrderEquivalence" ->
       /\ s.adapters = "memory,sqlite,cas"
       /\ s.exactOrder /\ s.adaptersEquivalent
    [] s.kind = "claimScanContinuation" ->
       /\ s.adapter \in {"memory", "sqlite", "cas"}
       /\ s.firstPageFull /\ s.exhaustedPassReturnsNone
       /\ s.wholeCandidatePageTerminalized /\ s.nextInvocationReachesLater
    [] s.kind = "stolenPageContinuation" ->
       /\ s.adapter \in LifecycleAdapterDomain
       /\ s.stalePassCanReturnShort /\ s.nextInvocationReachesBeyondPage /\ s.stolenRowsRemainOwned
    [] s.kind = "claimLimit" ->
       /\ s.adapter \in {"memory", "sqlite", "cas"}
       /\ s.exactReturnedLimit /\ s.exactRunningCount /\ s.laterDueRemainReachable
    [] s.kind = "finiteClaimDrain" ->
       /\ s.adapter \in {"memory", "sqlite", "cas"}
       /\ s.allUnique /\ s.allReached /\ s.boundedPasses
    [] s.kind = "adapterLifecycleEquivalence" -> /\ s.adapters = "memory,sqlite,cas" /\ s.equivalent
    [] s.kind = "terminalAckLoss" ->
       /\ s.outcomeKind \in {"succeed", "fail"}
       /\ s.exactAckError /\ s.durableTerminal /\ s.receiptDurable
       /\ s.replayConverges /\ s.noSecondWrite
    [] s.kind = "lifecycleArithmetic" ->
       /\ s.fenceOverflowExact /\ s.revisionOverflowExact /\ s.generationOverflowExact
       /\ s.maximumFiniteClaimAccepted
    [] OTHER -> FALSE
LifecycleSamplesConform(Samples) ==
  /\ Samples # {}
  /\ {s.kind : s \in Samples} = {
       "revisionHistorySplit", "terminalReceipt", "cancelOrdering", "leaseFenceCause",
       "generationCompetition", "resetCheckRace", "claimOrderEquivalence", "claimScanContinuation",
       "stolenPageContinuation", "claimLimit", "finiteClaimDrain", "adapterLifecycleEquivalence",
       "terminalAckLoss", "lifecycleArithmetic"
     }
  /\ {s.adapter : s \in {x \in Samples : x.kind = "claimScanContinuation"}} = LifecycleAdapterDomain
  /\ {s.adapter : s \in {x \in Samples : x.kind = "stolenPageContinuation"}} = LifecycleAdapterDomain
  /\ {s.adapter : s \in {x \in Samples : x.kind = "claimLimit"}} = LifecycleAdapterDomain
  /\ {s.adapter : s \in {x \in Samples : x.kind = "finiteClaimDrain"}} = LifecycleAdapterDomain
  /\ \A s \in Samples : LifecycleSampleOK(s)
=============================================================================
