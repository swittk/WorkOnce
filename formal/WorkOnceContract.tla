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
RunnerRejects(fatalPresent) == fatalPresent
ReadAllowed(definitionMatches) == definitionMatches
BackoffDelay(initial, factor, steps, cap) == MinValue(cap, initial * (factor ^ steps))

\* These records are fresh observations of compiled public APIs, not modeled test doubles.
BoundarySampleOK(s) ==
  CASE s.kind = "runner" ->
       /\ s.failureValue \in RunnerFailureDomain
       /\ s.returnedValue \in RunnerFailureDomain
       /\ s.rejected = RunnerRejects(~s.handled)
       /\ s.returnedValue = s.failureValue
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
       /\ s.adapter \in {"memory", "sqlite", "cas"}
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
    [] s.kind = "adapter" ->
       /\ s.adapter \in {"memory", "sqlite", "cas"}
       /\ s.threePassesSent
       /\ s.laterParentReached
       /\ s.wrapped
       /\ s.firstParentDrained
    [] OTHER -> FALSE
=============================================================================
