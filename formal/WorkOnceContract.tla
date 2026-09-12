-------------------------- MODULE WorkOnceContract --------------------------
EXTENDS Naturals

MinValue(a, b) == IF a <= b THEN a ELSE b
\* Matches the precedence of supported settlement when several budgets expire together.
DeferralStopReason(attemptLimit, elapsedLimit, deferLimit) ==
  IF attemptLimit THEN "attempt_budget_exhausted"
  ELSE IF elapsedLimit THEN "deadline_exceeded"
  ELSE IF deferLimit THEN "deferral_budget_exhausted"
  ELSE "none"

\* Presence of a failure is independent of its JavaScript rejection payload, while the
\* bounded runner abstraction still preserves representative payload identities exactly.
RunnerFailureValues == {"undefined", "null", "zero", "empty", "errorA", "errorB"}
RunnerFailureDomain == RunnerFailureValues \cup {"none"}
RunnerModes == {"local", "external"}
RunnerSites == {
  "firstFatal",
  "claim", "claimObserver", "active", "activeObserver",
  "handledClaim", "handledActive", "backoffBefore", "backoffDuring",
  "drain", "claimGate", "abortClaimReply", "abortActive"
}
RunnerRejects(fatalPresent) == fatalPresent
ReadAllowed(definitionMatches) == definitionMatches
ReadAdapterDomain == {"memory", "sqlite", "cas"}
BackoffDelay(initial, factor, steps, cap) == MinValue(cap, initial * (factor ^ steps))

\* These records are fresh observations of compiled public APIs, not modeled test doubles.
BoundarySampleOK(s) ==
  CASE s.kind = "runner" ->
       /\ s.mode \in RunnerModes
       /\ s.site \in RunnerSites
       /\ s.failureValue \in RunnerFailureDomain
       /\ s.returnedValue \in RunnerFailureDomain
       /\ s.rejected = RunnerRejects(~s.handled)
       /\ s.returnedValue = s.failureValue
       /\ (s.rejected <=> s.failureValue # "none")
       /\ s.preserved /\ s.drained /\ ~s.timedOut
       /\ (IF s.site = "claimGate" THEN s.started = 1 ELSE TRUE)
       /\ (IF s.site = "abortClaimReply" THEN s.started = 0 /\ s.reclaimed ELSE TRUE)
       /\ (IF s.site = "abortActive" THEN s.runSignalAborted /\ s.reclaimed ELSE TRUE)
    [] s.kind = "runnerHistory" ->
       /\ s.failureValue \in RunnerFailureValues
       /\ s.bothRejected /\ s.exactIdentityPreserved
       /\ s.sameTerminalProjection /\ s.sameReturnedValue
    [] s.kind = "read" ->
       /\ s.accepted = ReadAllowed(s.matched)
       /\ (s.matched => /\ s.snapshotExact /\ s.errorCause = "none")
       /\ (~s.matched => /\ s.definitionError /\ s.errorCause = "definition_changed")
    [] s.kind = "readAdapter" ->
       /\ s.adapter \in ReadAdapterDomain
       /\ s.definitionFenceExact /\ s.batchOrderExact /\ s.missingReadsExact
       /\ s.missingHistoryNotFound /\ s.wrongKindNotFound /\ s.wrongScopeNotFound
       /\ s.currentIdExact
    [] s.kind = "backoff" -> s.delay = BackoffDelay(s.initial, s.factor, s.steps, 64)
    [] s.kind = "budget" ->
       /\ s.stop = DeferralStopReason(s.attemptsExhausted, s.deadlineExhausted, s.deferralsExhausted)
       /\ s.reasonPreserved
    [] s.kind = "cancel" ->
       /\ ~s.cancelRejected
       /\ s.completionRejected = (s.first = "cancel")
       /\ s.state = (IF s.first = "cancel" THEN "cancelled" ELSE "succeeded")
       /\ s.cancelState = s.state
    [] OTHER -> FALSE

\* Each observation family must exercise every adapter independently. Pooled counts
\* cannot certify SQLite rotation by substituting an unrelated SQLite budget witness.
OutboxAdapterCoverage(S) ==
  \A kind \in {"adapter", "adapterBudget"} :
    {s.adapter : s \in {sample \in S : sample.kind = kind}} = {"memory", "sqlite", "cas"}

\* Fresh compiled outbox observations bind the hidden cursor/parent/child scheduler.
OutboxSampleOK(s) ==
  CASE s.kind = "rotation" ->
       /\ s.firstPassSent
       /\ s.firstParentPartiallyDrained
       /\ s.secondPassSent
       /\ s.laterParentReached
       /\ s.firstParentStillReachable
       /\ s.wrapped
       /\ s.thirdPassSent
       /\ s.firstParentDrained
    [] s.kind = "poison" ->
       /\ s.exactConflict
       /\ s.laterParentReached
       /\ s.healthySiblingReached
       /\ s.poisonRetained
    [] s.kind = "restart" ->
       /\ s.pendingPreserved
       /\ s.restartedFromBeginning
       /\ s.remainingChildDelivered
    [] s.kind = "ackLoss" ->
       /\ s.exactFailure
       /\ s.childDurableBeforeAck
       /\ s.parentIntentRetained
       /\ s.retryConverged
    [] s.kind = "casAckLoss" ->
       /\ s.exactChildAckLoss
       /\ s.childCommitAmbiguityConverges
       /\ s.exactParentAckLoss
       /\ s.parentCommitAmbiguityConverges
    [] s.kind = "adapter" ->
       /\ s.adapter \in {"memory", "sqlite", "cas"}
       /\ s.threePassesSent
       /\ s.laterParentReached
       /\ s.wrapped
       /\ s.firstParentDrained
    [] s.kind = "adapterBudget" ->
       /\ s.adapter \in {"memory", "sqlite", "cas"}
       /\ s.exactCounts
       /\ s.allParentsDrained
       /\ s.allChildrenDurable
       /\ s.maxSafeLimitWorks
    [] s.kind = "adapterFaults" ->
       /\ s.sixPrefixes
       /\ s.exactErrors
       /\ s.durablePrefixesMatch
       /\ s.allReplayConverge
    [] s.kind = "adapterConcurrent" ->
       /\ s.threeAdapters
       /\ s.allConverge
    [] s.kind = "budget" ->
       /\ s.exactTwoAttemptCounts
       /\ s.midParentBudgetPreserved
       /\ s.laterParentsReached
       /\ s.wrapped
       /\ s.maxSafeLimitDrains
    [] s.kind = "grid" ->
       /\ s.normalMatrixComplete
       /\ s.poisonMatrixComplete
       /\ s.allNormalConverged
       /\ s.allPoisonHealthyReached
    [] s.kind = "multiPoison" ->
       /\ s.limitOneConverges
       /\ s.limitTwoConverges
    [] s.kind = "dynamic" ->
       /\ s.insertedBeforeCursor
       /\ s.laterParentReached
       /\ s.insertedReachedAfterWrap
       /\ s.originalPartialStillReachable
    [] s.kind = "finiteArrivals" ->
       /\ s.allFiniteArrivalsReached
       /\ s.boundedAfterQuiescence
       /\ s.noPendingAfterQuiescence
    [] s.kind = "concurrent" ->
       /\ s.independentCursorsConverge
       /\ s.allChildrenDurable
       /\ s.boundedRounds
    [] s.kind = "limitBoundary" ->
       /\ s.invalidLimitsRejected
       /\ s.invalidLimitsNoQuery
       /\ s.invalidIntervalExact
    [] s.kind = "staleParent" ->
       /\ s.winnerAcked
       /\ s.rerunAdvancedGeneration
       /\ s.exactStaleCause
       /\ s.childPreserved
    [] s.kind = "rotationFailure" ->
       /\ s.originalCausePreserved
       /\ s.helperFailureNotSurfaced
       /\ s.durableIntentPreserved
    [] s.kind = "multiError" ->
       /\ s.exactContainer
       /\ s.exactCount
       /\ s.exactCauses
       /\ s.bothIntentsRetained
    [] s.kind = "runDispatcher" ->
       /\ s.exactPoisonObserved
       /\ s.observedWithinDeadline
       /\ s.neighborDelivered
       /\ s.healthySiblingDelivered
       /\ s.poisonStillRetained
    [] s.kind = "historyCongruence" ->
       /\ s.threeMaterialHistories
       /\ s.sameEnrichedProjection
       /\ s.sameNextFuture
       /\ s.futureProjectionEqual
    [] s.kind = "historySplit" ->
       /\ s.sameDurableProjection
       /\ s.differentImmediateFuture
       /\ s.cursorRequiredInAbstraction
       /\ s.eventualDurableConvergence
    [] OTHER -> FALSE
=============================================================================
