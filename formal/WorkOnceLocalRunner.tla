------------------------ MODULE WorkOnceLocalRunner ------------------------
EXTENDS Naturals, FiniteSets
CONSTANT Samples
VARIABLES pc, active, stopped, fatalPresent, lossPresent, lossValue, firstLossValue,
          returnPresent, returnValue, stopActive
vars == <<pc, active, stopped, fatalPresent, lossPresent, lossValue, firstLossValue,
          returnPresent, returnValue, stopActive>>
LossValues == {"none", "undefined", "errorA", "errorB", "abort"}
Stopped == stopped \/ fatalPresent

Init ==
  /\ pc = "ready"
  /\ active = 0
  /\ stopped = FALSE
  /\ fatalPresent = FALSE
  /\ lossPresent = FALSE
  /\ lossValue = "none"
  /\ firstLossValue = "none"
  /\ returnPresent = FALSE
  /\ returnValue = "none"
  /\ stopActive = 0

ClaimBegin ==
  /\ pc = "ready"
  /\ ~Stopped
  /\ active < 3
  /\ pc' = "claim"
  /\ UNCHANGED <<active, stopped, fatalPresent, lossPresent, lossValue, firstLossValue,
                 returnPresent, returnValue, stopActive>>

ClaimReply(hasWork) ==
  /\ pc = "claim"
  /\ hasWork \in BOOLEAN
  /\ IF Stopped
       THEN /\ pc' = "draining" /\ UNCHANGED <<active, stopActive>>
       ELSE IF hasWork
         THEN /\ pc' = "ready" /\ active' = active + 1 /\ UNCHANGED stopActive
         ELSE /\ pc' = "backoff" /\ UNCHANGED <<active, stopActive>>
  /\ UNCHANGED <<stopped, fatalPresent, lossPresent, lossValue, firstLossValue, returnPresent, returnValue>>

ClaimFault ==
  /\ pc = "claim"
  /\ pc' = "observer"
  /\ UNCHANGED <<active, stopped, fatalPresent, lossPresent, lossValue, firstLossValue,
                 returnPresent, returnValue, stopActive>>

ObserveHandled ==
  /\ pc = "observer"
  /\ pc' = IF Stopped THEN "draining" ELSE "backoff"
  /\ UNCHANGED <<active, stopped, fatalPresent, lossPresent, lossValue, firstLossValue,
                 returnPresent, returnValue, stopActive>>

ObserveFatal(value) ==
  /\ pc = "observer"
  /\ value \in LossValues \ {"none"}
  /\ LET fatalNow == ~fatalPresent IN
       /\ fatalPresent' = TRUE
       /\ lossPresent' = TRUE
       /\ lossValue' = IF fatalNow THEN value ELSE lossValue
       /\ firstLossValue' = IF fatalNow THEN value ELSE firstLossValue
       /\ stopActive' = IF fatalNow /\ ~Stopped THEN active ELSE stopActive
  /\ pc' = "draining"
  /\ UNCHANGED <<active, stopped, returnPresent, returnValue>>

ActiveDone(failed, handled, value) ==
  /\ active > 0
  /\ failed \in BOOLEAN
  /\ handled \in BOOLEAN
  /\ value \in LossValues \ {"none"}
  /\ active' = active - 1
  /\ LET fatalNow == failed /\ ~handled /\ ~stopped /\ ~fatalPresent IN
       /\ fatalPresent' = (fatalPresent \/ fatalNow)
       /\ lossPresent' = (lossPresent \/ fatalNow)
       /\ lossValue' = IF fatalNow THEN value ELSE lossValue
       /\ firstLossValue' = IF fatalNow THEN value ELSE firstLossValue
       /\ stopActive' = IF fatalNow /\ ~Stopped THEN active - 1 ELSE stopActive
       /\ pc' = IF pc = "backoff"
                 THEN IF fatalPresent' \/ stopped THEN "draining" ELSE "ready"
                 ELSE pc
  /\ UNCHANGED <<stopped, returnPresent, returnValue>>

CallerStop ==
  /\ ~stopped
  /\ pc # "done"
  /\ stopped' = TRUE
  /\ pc' = IF pc \in {"ready", "backoff"} THEN "draining" ELSE pc
  /\ stopActive' = IF Stopped THEN stopActive ELSE active
  /\ UNCHANGED <<active, fatalPresent, lossPresent, lossValue, firstLossValue, returnPresent, returnValue>>

PollTimeout ==
  /\ pc = "backoff"
  /\ ~Stopped
  /\ pc' = "ready"
  /\ UNCHANGED <<active, stopped, fatalPresent, lossPresent, lossValue, firstLossValue,
                 returnPresent, returnValue, stopActive>>

Drain ==
  /\ pc = "ready"
  /\ Stopped
  /\ pc' = "draining"
  /\ UNCHANGED <<active, stopped, fatalPresent, lossPresent, lossValue, firstLossValue,
                 returnPresent, returnValue, stopActive>>

Finish ==
  /\ pc = "draining"
  /\ active = 0
  /\ pc' = "done"
  /\ returnPresent' = fatalPresent
  /\ returnValue' = IF fatalPresent THEN lossValue ELSE "none"
  /\ UNCHANGED <<active, stopped, fatalPresent, lossPresent, lossValue, firstLossValue, stopActive>>

Next == ClaimBegin
        \/ (\E hasWork \in BOOLEAN : ClaimReply(hasWork))
        \/ ClaimFault
        \/ ObserveHandled
        \/ (\E value \in LossValues \ {"none"} : ObserveFatal(value))
        \/ (\E failed \in BOOLEAN, handled \in BOOLEAN,
             value \in LossValues \ {"none"} : ActiveDone(failed, handled, value))
        \/ CallerStop \/ PollTimeout \/ Drain \/ Finish
Spec == Init /\ [][Next]_vars

LocalTypeOK ==
  /\ pc \in {"ready", "claim", "observer", "backoff", "draining", "done"}
  /\ active \in 0..3
  /\ stopped \in BOOLEAN
  /\ fatalPresent \in BOOLEAN
  /\ lossPresent \in BOOLEAN
  /\ lossValue \in LossValues
  /\ firstLossValue \in LossValues
  /\ returnPresent \in BOOLEAN
  /\ returnValue \in LossValues
  /\ stopActive \in 0..3

LossPresenceExact ==
  /\ fatalPresent = lossPresent
  /\ (fatalPresent => lossValue # "none")
  /\ (~fatalPresent => lossValue = "none")
LocalFirstFatalValuePreserved ==
  /\ (fatalPresent => /\ firstLossValue # "none" /\ lossValue = firstLossValue)
  /\ (~fatalPresent => firstLossValue = "none")

LocalNoAdmissionAfterStop == Stopped => active <= stopActive
LocalDrainedBeforeReturn == pc = "done" => active = 0
LocalNoFatalBackoff == fatalPresent => pc # "backoff"
LocalFatalReturnPreserves ==
  pc = "done" =>
    /\ returnPresent = fatalPresent
    /\ returnValue = IF fatalPresent THEN lossValue ELSE "none"

LocalAdapterDomain == {"memory", "sqlite", "cas"}
StopReclaimAdapterModes == {
  <<"memory", "caller">>, <<"memory", "heartbeat">>,
  <<"sqlite", "caller">>, <<"sqlite", "heartbeat">>,
  <<"cas", "caller">>, <<"cas", "heartbeat">>
}

LocalRunnerSampleOK(s) ==
  CASE s.kind = "stopReclaim" ->
       /\ s.adapter \in {"memory", "sqlite", "cas"}
       /\ s.mode \in {"caller", "heartbeat"}
       /\ s.exactCause /\ s.leftRunning /\ s.reclaimAdvanced
    [] s.kind = "undefinedHeartbeat" ->
       /\ s.adapter \in {"memory", "sqlite", "cas"}
       /\ s.interrupted /\ s.exactUndefined
    [] s.kind = "settleCause" ->
       /\ s.adapter \in {"memory", "sqlite", "cas"}
       /\ s.exactCause /\ s.stillRunning
    [] s.kind = "competingRunners" ->
       /\ s.adapter \in {"memory", "sqlite", "cas"}
       /\ s.bothOwners /\ s.exactlyOnce
    [] s.kind = "firstFatal" -> s.bothActive /\ s.exactFirst
    [] s.kind = "dynamicArrival" ->
       /\ s.allTen /\ s.boundedCapacity /\ s.refilledAroundSlow
    [] s.kind = "handledRecovery" -> s.exactErrors /\ s.eventuallyRanOnce
    [] s.kind = "completionOrder" -> s.sameProjection /\ s.sameFuture
    [] s.kind = "handledAbortHistory" -> s.sameDurable /\ s.sameFuture
    [] s.kind = "backoffHistory" -> s.handledOnce /\ s.sameDurable /\ s.sameFuture
    [] s.kind = "lateClaimStop" -> s.oneHandler /\ s.lateLeaseNotExecuted
    [] s.kind = "timerBoundary" ->
       /\ s.exactLeaseRejects /\ s.oneBelowAccepts /\ s.hugeFiniteAccepted
       /\ s.expiryCauseExact /\ s.hugeIdleInterruptible
    [] s.kind = "wakePoll" -> s.exactCause /\ s.promptlyWoken
    [] OTHER -> FALSE

LocalRunnerSamplesConform ==
  /\ Samples # {}
  /\ {s.kind : s \in Samples} = {
       "stopReclaim", "undefinedHeartbeat", "settleCause", "competingRunners",
       "firstFatal", "dynamicArrival", "handledRecovery", "completionOrder", "handledAbortHistory",
       "backoffHistory", "lateClaimStop", "timerBoundary", "wakePoll"
     }
  /\ {<<s.adapter, s.mode>> : s \in {x \in Samples : x.kind = "stopReclaim"}} = StopReclaimAdapterModes
  /\ {s.adapter : s \in {x \in Samples : x.kind = "undefinedHeartbeat"}} = LocalAdapterDomain
  /\ {s.adapter : s \in {x \in Samples : x.kind = "settleCause"}} = LocalAdapterDomain
  /\ {s.adapter : s \in {x \in Samples : x.kind = "competingRunners"}} = LocalAdapterDomain
  /\ \A s \in Samples : LocalRunnerSampleOK(s)
=============================================================================
