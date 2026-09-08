-------------------------- MODULE WorkOnceContract --------------------------
EXTENDS Naturals

MinValue(a, b) == IF a <= b THEN a ELSE b
\* Matches the precedence of supported settlement when several budgets expire together.
DeferralStopReason(attemptLimit, elapsedLimit, deferLimit) ==
  IF attemptLimit THEN "attempt_budget_exhausted"
  ELSE IF elapsedLimit THEN "deadline_exceeded"
  ELSE IF deferLimit THEN "deferral_budget_exhausted"
  ELSE "none"

\* Presence of a failure is independent of its JavaScript rejection payload.
RunnerRejects(fatalPresent) == fatalPresent
ReadAllowed(definitionMatches) == definitionMatches
BackoffDelay(initial, factor, steps, cap) == MinValue(cap, initial * (factor ^ steps))

\* These records are fresh observations of compiled public APIs, not modeled test doubles.
BoundarySampleOK(s) ==
  CASE s.kind = "runner" ->
       /\ s.rejected = RunnerRejects(~s.handled)
       /\ s.preserved /\ s.drained /\ ~s.timedOut
       /\ (IF s.site = "claimGate" THEN s.started = 1 ELSE TRUE)
    [] s.kind = "read" ->
       /\ s.accepted = ReadAllowed(s.matched)
       /\ (~s.matched => s.definitionError)
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
=============================================================================
