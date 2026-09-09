-------------------------- MODULE WorkOnceExternal --------------------------
EXTENDS Naturals, FiniteSets
CONSTANT Samples
VARIABLES phase, fence, exports, effects, receiptFence, lastRejectedFence, reply
vars == <<phase, fence, exports, effects, receiptFence, lastRejectedFence, reply>>

Init ==
  /\ phase = "available"
  /\ fence = 0
  /\ exports = {}
  /\ effects = {}
  /\ receiptFence = 0
  /\ lastRejectedFence = 0
  /\ reply = "none"

ClaimExport ==
  /\ phase = "available" /\ fence < 2
  /\ phase' = "running"
  /\ fence' = fence + 1
  /\ exports' = exports \cup {fence + 1}
  /\ reply' = "lease"
  /\ UNCHANGED <<effects, receiptFence, lastRejectedFence>>

ExternalEffect ==
  /\ phase = "running" /\ fence \in exports
  /\ effects' = effects \cup {fence}
  /\ reply' = "effect"
  /\ UNCHANGED <<phase, fence, exports, receiptFence, lastRejectedFence>>

CrashExpire ==
  /\ phase = "running"
  /\ phase' = "available"
  /\ reply' = "crash"
  /\ UNCHANGED <<fence, exports, effects, receiptFence, lastRejectedFence>>

HeartbeatCurrent ==
  /\ phase = "running" /\ fence \in exports
  /\ reply' = "heartbeat"
  /\ UNCHANGED <<phase, fence, exports, effects, receiptFence, lastRejectedFence>>

RejectStale(f) ==
  /\ f \in exports /\ f # fence
  /\ lastRejectedFence' = f
  /\ reply' = "stale"
  /\ UNCHANGED <<phase, fence, exports, effects, receiptFence>>

SettleCurrent(knownAck) ==
  /\ phase = "running" /\ fence \in exports /\ knownAck \in BOOLEAN
  /\ phase' = "succeeded"
  /\ receiptFence' = fence
  /\ reply' = IF knownAck THEN "settled" ELSE "unknown"
  /\ UNCHANGED <<fence, exports, effects, lastRejectedFence>>

Replay ==
  /\ phase = "succeeded" /\ receiptFence = fence /\ fence \in exports
  /\ reply' = "replay"
  /\ UNCHANGED <<phase, fence, exports, effects, receiptFence, lastRejectedFence>>

Next == ClaimExport \/ ExternalEffect \/ CrashExpire \/ HeartbeatCurrent \/ Replay
        \/ (\E f \in exports : RejectStale(f))
        \/ (\E knownAck \in BOOLEAN : SettleCurrent(knownAck))
Spec == Init /\ [][Next]_vars

ExternalTypeOK ==
  /\ phase \in {"available", "running", "succeeded"}
  /\ fence \in 0..2
  /\ exports \subseteq 1..2
  /\ effects \subseteq 1..2
  /\ receiptFence \in 0..2
  /\ lastRejectedFence \in 0..2
  /\ reply \in {"none", "lease", "effect", "crash", "heartbeat", "stale", "settled", "unknown", "replay"}

CurrentRunningExported == phase = "running" => fence \in exports
SuccessReceiptCurrent == phase = "succeeded" => /\ receiptFence = fence /\ fence \in exports
EffectsRequireExport == effects \subseteq exports
RejectedFenceIsStale == lastRejectedFence = 0 \/ lastRejectedFence < fence
UnknownAckIsDurable == reply = "unknown" => /\ phase = "succeeded" /\ receiptFence = fence

\* Intentionally NOT an invariant of supported external effects. The formal runner
\* separately requires TLC to violate this predicate, matching the real SIGKILL
\* effect-before-settlement process witness.
NoDuplicateExternalEffects == Cardinality(effects) <= 1

ExternalSampleOK(s) ==
  CASE s.kind = "handoffHistory" ->
       /\ s.materiallyDifferentHistory /\ s.sameLease /\ s.sameDurableProjection /\ s.sameFuture
    [] s.kind = "prepareRace" ->
       /\ s.race \in {"cancel", "reclaim"}
       /\ s.noStaleLeaseExported /\ s.noDomainErrorConversion /\ s.winnerPreserved
    [] s.kind = "prepareDisposition" ->
       /\ s.oneLease /\ s.waitSettledLocally /\ s.errorSettledLocally
       /\ s.healthyStillRunning /\ s.exactPrepareError
    [] s.kind = "unknownSettleAck" ->
       /\ s.exactAckError /\ s.handlerOnce /\ s.durableSuccess /\ s.replayConverged /\ s.noLocalRerun
    [] s.kind = "staleForeignAttempt" ->
       /\ s.fenceAdvanced /\ s.heartbeatExact /\ s.settleExact /\ s.winnerPreserved /\ s.winnerSettled
    [] s.kind = "capacityFairness" ->
       /\ s.exactHandledFailure /\ s.laterHealthyAdmitted /\ s.healthySettled /\ s.boundedClaims /\ s.noFatalEscape
    [] s.kind = "oversizedClaim" -> /\ s.exactError /\ s.noHandlerStarted
    [] s.kind = "stopSignal" -> /\ s.preAbortedNoClaim /\ s.sameSignalPropagated /\ s.abortDuringClaimFulfills
    [] s.kind = "leaseBoundary" ->
       /\ s.zeroRejectedBeforeHandler /\ s.nanRejectedBeforeHandler
       /\ s.maxSafeAccepted /\ s.oneTickHeartbeatCompatible /\ s.invalidRenewalExact
       /\ s.exactHeartbeatBoundary
    [] s.kind = "heartbeatFailure" ->
       /\ s.exactAbortObserved /\ s.interruptedBeforeSettle /\ s.ownershipLossCause
    [] s.kind = "externalAdapterEquivalence" ->
       /\ s.equivalent /\ s.adapters = "memory,sqlite,cas" /\ s.exactConflict
    [] s.kind = "unknownAckHistory" ->
       /\ s.materiallyDifferentCallerHistory /\ s.sameDurableProjection /\ s.sameFuture
    [] OTHER -> FALSE

ExternalSamplesConform ==
  /\ Samples # {}
  /\ {s.kind : s \in Samples} = {
       "handoffHistory", "prepareRace", "prepareDisposition", "unknownSettleAck",
       "staleForeignAttempt", "capacityFairness", "oversizedClaim", "stopSignal",
       "leaseBoundary", "heartbeatFailure", "externalAdapterEquivalence", "unknownAckHistory"
     }
  /\ \A s \in Samples : ExternalSampleOK(s)
=============================================================================
