------------------------- MODULE WorkOnceReadHistory -------------------------
EXTENDS Naturals, FiniteSets, Sequences
CONSTANT Samples
VARIABLES left, right, leftHistory, rightHistory, futureHistory, historyWrites, depth
vars == <<left, right, leftHistory, rightHistory, futureHistory, historyWrites, depth>>

HistoryLimit == 128
MaxDepth == 3
DifferenceIndex == 96
States == {"queued", "running", "waiting", "failed", "succeeded", "cancelled"}
WaitCauses == {"none", "retry", "defer"}
Ops == {"claim", "heartbeat", "succeed", "fail", "retry", "defer", "cancel", "wake",
         "manual_retry", "rerun"}
HistoryWritingOps == Ops \ {"heartbeat"}
ReadHistoryAdapterDomain == {"memory", "sqlite", "cas"}
ReadHistoryModeDomain == {"readerFirst", "writerFirst", "mixed"}

BaseProjection == [state |-> "queued", waitCause |-> "none", generation |-> 2,
                   revision |-> 10, fence |-> 3, attempts |-> 0]
BaseHistoryA == [i \in 1..HistoryLimit |-> IF i = DifferenceIndex THEN "old:history-A" ELSE "old:common"]
BaseHistoryB == [i \in 1..HistoryLimit |-> IF i = DifferenceIndex THEN "old:history-B" ELSE "old:common"]

Outcome(p, op) ==
  CASE op = "claim" -> IF p.state \in {"queued", "waiting"} THEN "ok" ELSE "not_due"
    [] op \in {"heartbeat", "succeed", "fail", "retry", "defer"} ->
         IF p.state = "running" THEN "ok" ELSE "stale_attempt"
    [] op = "cancel" -> IF p.state \in {"queued", "running", "waiting"} THEN "ok" ELSE "terminal_noop"
    [] op = "wake" -> IF p.state \in {"queued", "waiting"} THEN "ok" ELSE "retry_denied"
    [] op = "manual_retry" -> IF p.state = "failed" THEN "ok" ELSE "retry_denied"
    [] op = "rerun" -> IF p.state = "succeeded" THEN "ok" ELSE "retry_denied"
    [] OTHER -> "unsupported"

Enabled(p) == {op \in Ops : Outcome(p, op) = "ok"}

Apply(p, op) ==
  IF Outcome(p, op) # "ok" THEN p
  ELSE CASE op = "claim" ->
         [p EXCEPT !.state = "running", !.waitCause = "none", !.revision = @ + 1,
                    !.fence = @ + 1, !.attempts = @ + 1]
    [] op = "heartbeat" -> [p EXCEPT !.revision = @ + 1]
    [] op = "succeed" -> [p EXCEPT !.state = "succeeded", !.waitCause = "none", !.revision = @ + 1]
    [] op = "fail" -> [p EXCEPT !.state = "failed", !.waitCause = "none", !.revision = @ + 1]
    [] op = "retry" -> [p EXCEPT !.state = "waiting", !.waitCause = "retry", !.revision = @ + 1]
    [] op = "defer" -> [p EXCEPT !.state = "waiting", !.waitCause = "defer", !.revision = @ + 1]
    [] op = "cancel" -> [p EXCEPT !.state = "cancelled", !.waitCause = "none", !.revision = @ + 1]
    [] op = "wake" -> [p EXCEPT !.revision = @ + 1]
    [] op = "manual_retry" ->
         [p EXCEPT !.state = "queued", !.waitCause = "none", !.generation = @ + 1,
                    !.revision = @ + 1, !.attempts = 0]
    [] op = "rerun" ->
         [p EXCEPT !.state = "queued", !.waitCause = "none", !.generation = @ + 1,
                    !.revision = @ + 1, !.attempts = 0]
    [] OTHER -> p

WritesHistory(p, op) == Outcome(p, op) = "ok" /\ op \in HistoryWritingOps
HistoryEvent(p, op) == op
TrimAppend(history, event) == Append(SubSeq(history, 2, Len(history)), event)
ExpectedHistory(base) ==
  IF historyWrites = 0 THEN base
  ELSE SubSeq(base, historyWrites + 1, HistoryLimit) \o futureHistory

Init ==
  /\ left = BaseProjection
  /\ right = BaseProjection
  /\ leftHistory = BaseHistoryA
  /\ rightHistory = BaseHistoryB
  /\ futureHistory = <<>>
  /\ historyWrites = 0
  /\ depth = 0

Step(op) ==
  /\ depth < MaxDepth
  /\ op \in Ops
  /\ LET writes == WritesHistory(left, op) IN
       /\ left' = Apply(left, op)
       /\ right' = Apply(right, op)
       /\ leftHistory' = IF writes THEN TrimAppend(leftHistory, HistoryEvent(left, op)) ELSE leftHistory
       /\ rightHistory' = IF writes THEN TrimAppend(rightHistory, HistoryEvent(right, op)) ELSE rightHistory
       /\ futureHistory' = IF writes THEN Append(futureHistory, HistoryEvent(left, op)) ELSE futureHistory
       /\ historyWrites' = IF writes THEN historyWrites + 1 ELSE historyWrites
       /\ depth' = depth + 1

Next == \E op \in Ops : Step(op)
Spec == Init /\ [][Next]_vars

ReadHistoryTypeOK ==
  /\ left.state \in States /\ right.state \in States
  /\ left.waitCause \in WaitCauses /\ right.waitCause \in WaitCauses
  /\ left.generation \in 1..5 /\ right.generation \in 1..5
  /\ left.revision \in 1..20 /\ right.revision \in 1..20
  /\ left.fence \in 0..10 /\ right.fence \in 0..10
  /\ left.attempts \in 0..5 /\ right.attempts \in 0..5
  /\ depth \in 0..MaxDepth /\ historyWrites \in 0..MaxDepth
  /\ Len(futureHistory) = historyWrites

CurrentProjectionCongruent == left = right
EnabledFutureCongruent == Enabled(left) = Enabled(right)
OutcomeFutureCongruent == \A op \in Ops : Outcome(left, op) = Outcome(right, op)
HistoryBounded == Len(leftHistory) = HistoryLimit /\ Len(rightHistory) = HistoryLimit
HistoryRetentionOrder ==
  /\ leftHistory = ExpectedHistory(BaseHistoryA)
  /\ rightHistory = ExpectedHistory(BaseHistoryB)
HistoryDifferenceVisible == leftHistory # rightHistory

ReadHistorySampleOK(s) ==
  CASE s.kind = "historyCongruence" ->
       /\ s.sameCurrentProjection
       /\ s.differentHistory
       /\ s.historyOnlyDurableDifference
       /\ s.allFutureProjectionsSame
       /\ s.allFutureResultsSame
       /\ s.allFutureHistoryTailsSame
       /\ s.allFutureHistoryDifferencePreserved
       /\ s.futureTraceCount >= 5
    [] s.kind = "historyTruncation" ->
       /\ s.exactly128
       /\ s.latestActionsExact
       /\ s.latestReasonsExact
       /\ s.oldestDropped
       /\ s.newestRetained
       /\ s.publicEqualsDurable
    [] s.kind = "inspectManyRace" ->
       /\ s.adapter \in ReadHistoryAdapterDomain
       /\ s.mode \in ReadHistoryModeDomain
       /\ s.callerOrderExact
       /\ s.perIdRealState
       /\ s.expectedEndpoint
       /\ s.oneStorageClock
       /\ s.perIdContractPreserved
       /\ ~s.crossIdAtomicSnapshotRequired
       /\ (s.mode = "mixed" => s.mixedRevision)
    [] OTHER -> FALSE

AdapterSetFor(kind) == {sample.adapter : sample \in {candidate \in Samples : candidate.kind = kind}}
ModeSetFor(kind) == {sample.mode : sample \in {candidate \in Samples : candidate.kind = kind}}
ReadHistorySamplesConform ==
  /\ Samples # {}
  /\ {s.kind : s \in Samples} = {"historyCongruence", "historyTruncation", "inspectManyRace"}
  /\ AdapterSetFor("inspectManyRace") = ReadHistoryAdapterDomain
  /\ ModeSetFor("inspectManyRace") = ReadHistoryModeDomain
  /\ \A s \in Samples : ReadHistorySampleOK(s)
=============================================================================
