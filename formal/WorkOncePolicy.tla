--------------------------- MODULE WorkOncePolicy ---------------------------
EXTENDS Naturals, FiniteSets, WorkOnceContract
CONSTANT Samples
VARIABLES pc, phase, revision, snapRevision, fence, oldReferenceFence,
          receiptFence, receipt, snapReceiptFence, snapReceipt,
          faultRevision, faultPhase, faultReceiptFence, faultReceipt,
          submission, reply
vars == <<pc, phase, revision, snapRevision, fence, oldReferenceFence,
          receiptFence, receipt, snapReceiptFence, snapReceipt,
          faultRevision, faultPhase, faultReceiptFence, faultReceipt,
          submission, reply>>

RetryStopReason(policyAllows, retryLimit, attemptLimit, deadlineLimit) ==
  IF ~policyAllows THEN "retry_not_allowed"
  ELSE IF retryLimit THEN "retry_budget_exhausted"
  ELSE IF attemptLimit THEN "attempt_budget_exhausted"
  ELSE IF deadlineLimit THEN "deadline_exceeded"
  ELSE "none"

DeferStopReason(attemptLimit, deadlineLimit, deferralLimit) ==
  DeferralStopReason(attemptLimit, deadlineLimit, deferralLimit)

Init ==
  /\ pc = "running" /\ phase = "running"
  /\ revision = 1 /\ snapRevision = 0 /\ fence = 1 /\ oldReferenceFence = 0
  /\ receiptFence = 0 /\ receipt = "none"
  /\ snapReceiptFence = 0 /\ snapReceipt = "none"
  /\ faultRevision = 0 /\ faultPhase = "none"
  /\ faultReceiptFence = 0 /\ faultReceipt = "none"
  /\ submission = "none" /\ reply = "none"

BeginPolicy ==
  /\ pc = "running"
  /\ pc' = "policy"
  /\ snapRevision' = revision
  /\ snapReceiptFence' = receiptFence /\ snapReceipt' = receipt
  /\ UNCHANGED <<phase, revision, fence, oldReferenceFence, receiptFence, receipt,
                 faultRevision, faultPhase, faultReceiptFence, faultReceipt,
                 submission, reply>>

\* A callback can fail before the fenced storage commit, even if a competing
\* command changed the durable row while the callback was in flight.
PolicyFault ==
  /\ pc = "policy"
  /\ pc' = "done" /\ reply' = "callbackError"
  /\ faultRevision' = revision /\ faultPhase' = phase
  /\ faultReceiptFence' = receiptFence /\ faultReceipt' = receipt
  /\ UNCHANGED <<phase, revision, snapRevision, fence, oldReferenceFence,
                 receiptFence, receipt, snapReceiptFence, snapReceipt, submission>>

CancelDuringPolicy ==
  /\ pc = "policy" /\ phase = "running" /\ revision = snapRevision
  /\ phase' = "cancelled" /\ revision' = revision + 1
  /\ UNCHANGED <<pc, snapRevision, fence, oldReferenceFence, receiptFence, receipt,
                 snapReceiptFence, snapReceipt, faultRevision, faultPhase,
                 faultReceiptFence, faultReceipt, submission, reply>>

ReclaimDuringPolicy ==
  /\ pc = "policy" /\ phase = "running" /\ revision = snapRevision /\ fence < 2
  /\ phase' = "running" /\ revision' = revision + 1 /\ fence' = fence + 1
  /\ UNCHANGED <<pc, snapRevision, oldReferenceFence, receiptFence, receipt,
                 snapReceiptFence, snapReceipt, faultRevision, faultPhase,
                 faultReceiptFence, faultReceipt, submission, reply>>

CommitPolicy(s) ==
  /\ pc = "policy" /\ s \in {"implicit", "explicit"}
  /\ submission' = s
  /\ IF revision # snapRevision \/ phase # "running"
       THEN /\ pc' = "done" /\ reply' = "stale"
            /\ UNCHANGED <<phase, revision, snapRevision, fence, oldReferenceFence,
                           receiptFence, receipt, snapReceiptFence, snapReceipt,
                           faultRevision, faultPhase, faultReceiptFence, faultReceipt>>
       ELSE /\ pc' = "waiting" /\ phase' = "waiting"
            /\ revision' = revision + 1
            /\ receiptFence' = fence /\ receipt' = s /\ reply' = "waiting"
            /\ UNCHANGED <<snapRevision, fence, oldReferenceFence, snapReceiptFence, snapReceipt,
                           faultRevision, faultPhase, faultReceiptFence, faultReceipt>>

\* A waiting row can be claimed again while retaining the previous attempt's
\* receipt. Old duplicates remain replayable until a newer settlement replaces it.
ClaimNext ==
  /\ pc = "waiting" /\ phase = "waiting" /\ fence < 2
  /\ pc' = "running" /\ phase' = "running"
  /\ revision' = revision + 1 /\ fence' = fence + 1
  /\ oldReferenceFence' = receiptFence
  /\ submission' = "none" /\ reply' = "none"
  /\ UNCHANGED <<snapRevision, receiptFence, receipt,
                 snapReceiptFence, snapReceipt, faultRevision, faultPhase,
                 faultReceiptFence, faultReceipt>>

ReplayReceipt(s) ==
  /\ receipt # "none" /\ receiptFence \in 1..fence
  /\ s \in {"implicit", "explicit"}
  /\ submission' = s
  /\ reply' = IF s = receipt THEN "replay" ELSE "conflict"
  /\ UNCHANGED <<pc, phase, revision, snapRevision, fence, oldReferenceFence,
                 receiptFence, receipt, snapReceiptFence, snapReceipt,
                 faultRevision, faultPhase, faultReceiptFence, faultReceipt>>

\* Once attempt 2 publishes its own receipt, an attempt-1 ref no longer matches
\* the retained receipt fence and therefore falls through to stale-attempt fencing.
ReplaySupersededOld ==
  /\ phase = "waiting" /\ fence = 2 /\ receiptFence = 2
  /\ reply' = "staleOld" /\ submission' = "implicit"
  /\ UNCHANGED <<pc, phase, revision, snapRevision, fence, oldReferenceFence,
                 receiptFence, receipt, snapReceiptFence, snapReceipt,
                 faultRevision, faultPhase, faultReceiptFence, faultReceipt>>

Next == BeginPolicy \/ PolicyFault \/ CancelDuringPolicy \/ ReclaimDuringPolicy
        \/ ClaimNext \/ ReplaySupersededOld
        \/ (\E s \in {"implicit", "explicit"} : CommitPolicy(s) \/ ReplayReceipt(s))
Spec == Init /\ [][Next]_vars

PolicyTypeOK ==
  /\ pc \in {"running", "policy", "waiting", "done"}
  /\ phase \in {"running", "waiting", "cancelled"}
  /\ revision \in 1..4 /\ snapRevision \in 0..3 /\ fence \in 1..2
  /\ oldReferenceFence \in 0..2
  /\ receiptFence \in 0..2 /\ receipt \in {"none", "implicit", "explicit"}
  /\ snapReceiptFence \in 0..2 /\ snapReceipt \in {"none", "implicit", "explicit"}
  /\ faultRevision \in 0..4 /\ faultPhase \in {"none", "running", "waiting", "cancelled"}
  /\ faultReceiptFence \in 0..2 /\ faultReceipt \in {"none", "implicit", "explicit"}
  /\ submission \in {"none", "implicit", "explicit"}
  /\ reply \in {"none", "waiting", "stale", "callbackError", "replay", "conflict", "staleOld"}

StalePolicyCannotPublish ==
  pc = "done" /\ reply = "stale" =>
    /\ receipt = snapReceipt /\ receiptFence = snapReceiptFence

PolicyFailureNoWrite ==
  pc = "done" /\ reply = "callbackError" =>
    /\ revision = faultRevision /\ phase = faultPhase
    /\ receiptFence = faultReceiptFence /\ receipt = faultReceipt

ReceiptIdentityControlsReplay ==
  reply \in {"replay", "conflict"} =>
    /\ receipt \in {"implicit", "explicit"}
    /\ (reply = "replay") = (submission = receipt)

ReceiptFenceTracksPublishedAttempt ==
  /\ (receipt = "none") = (receiptFence = 0)
  /\ receiptFence <= fence
  /\ (phase = "waiting" => receiptFence = fence)

SupersededReceiptRejectsOld ==
  reply = "staleOld" =>
    /\ phase = "waiting" /\ fence = 2
    /\ oldReferenceFence \in 1..(fence - 1)
    /\ oldReferenceFence # receiptFence

PolicySampleOK(s) ==
  CASE s.kind = "retryBoundary" ->
       /\ s.stop = RetryStopReason(s.policyAllows, s.retryLimit, s.attemptLimit, s.deadlineLimit)
       /\ s.expected = s.stop /\ s.reasonPreserved /\ s.counterExact
    [] s.kind = "deferBoundary" ->
       /\ s.stop = DeferStopReason(s.attemptLimit, s.deadlineLimit, s.deferralLimit)
       /\ s.expected = s.stop /\ s.reasonPreserved /\ s.counterExact
    [] s.kind = "backoffFinite" -> /\ s.matchesExpected /\ s.safeInteger
    [] s.kind = "policyRace" ->
       /\ s.callbackOnce /\ s.contextExact /\ s.exactStale /\ s.winnerPreserved
    [] s.kind = "policyFailure" ->
       /\ s.exactError /\ s.callbackOnce /\ s.noWrite /\ s.stillRunning
    [] s.kind = "policyReplay" -> /\ s.callbackOnce /\ s.samePhase /\ s.waiting
    [] s.kind = "casAckLoss" ->
       /\ s.outcomeKind \in {"retry", "defer"}
       /\ s.exactAckError /\ s.committedWaiting /\ s.replayConverged
       /\ s.callbackOnce /\ s.counterOnce
    [] s.kind = "receiptSplit" ->
       /\ s.samePublic /\ s.differentReceipt /\ s.otherwiseSameDurable
       /\ s.sameReplayAccepted /\ s.crossReplayConflict
    [] s.kind = "receiptAcrossAttempts" ->
       /\ s.outcomeKind \in {"retry", "defer"}
       /\ s.firstReceiptFence /\ s.oldReplayDuringNewAttempt /\ s.oldConflictExact
       /\ s.secondReceiptFence /\ s.oldReplayAfterReplacementStale
    [] s.kind = "historyCongruence" ->
       /\ s.materiallyDifferentHistory /\ s.sameDurableProjection /\ s.sameFuture
    [] s.kind = "wakeCompetition" ->
       /\ s.adapter \in {"memory", "sqlite", "cas"}
       /\ s.exactlyOneWake /\ s.exactLoser /\ s.immediateEligibility
       /\ s.claimable /\ s.terminalCauseExact
    [] s.kind = "adapterEquivalence" ->
       /\ s.outcomeKind \in {"retry", "defer"}
       /\ s.adapters = "memory,sqlite,cas" /\ s.equivalent
    [] s.kind = "timingBoundary" ->
       /\ s.pastClampedToNow /\ s.exactDeadlineStops /\ s.hugeDelaySaturates
       /\ s.exactBothError /\ s.invalidTimingNoWrite
    [] OTHER -> FALSE

PolicyOutcomeCoverage(kind) ==
  {s.outcomeKind : s \in {sample \in Samples : sample.kind = kind}}
PolicyDualOutcomeKinds == {"casAckLoss", "receiptAcrossAttempts", "adapterEquivalence"}

PolicySamplesConform ==
  /\ Samples # {}
  /\ {s.kind : s \in Samples} = {
       "retryBoundary", "deferBoundary", "backoffFinite", "policyRace", "policyFailure",
       "policyReplay", "casAckLoss", "receiptSplit", "receiptAcrossAttempts",
       "historyCongruence", "wakeCompetition", "adapterEquivalence", "timingBoundary"
     }
  /\ {s.adapter : s \in {x \in Samples : x.kind = "wakeCompetition"}} = {"memory", "sqlite", "cas"}
  /\ \A kind \in PolicyDualOutcomeKinds : PolicyOutcomeCoverage(kind) = {"retry", "defer"}
  /\ \A s \in Samples : PolicySampleOK(s)
=============================================================================
