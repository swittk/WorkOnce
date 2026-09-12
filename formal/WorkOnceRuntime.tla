--------------------------- MODULE WorkOnceRuntime ---------------------------
EXTENDS Naturals, FiniteSets, WorkOnceContract
CONSTANT Samples
VARIABLES pc, active, fatalPresent, failureKind, failureValue, firstFatalValue, aborted, result, returnValue, stopActive
vars == <<pc, active, fatalPresent, failureKind, failureValue, firstFatalValue, aborted, result, returnValue, stopActive>>
Stopped == fatalPresent \/ aborted
FailureKind(value) ==
  IF value = "none" THEN "none"
  ELSE IF value = "undefined" THEN "undefined"
  ELSE "defined"
Init == /\ pc = "ready" /\ active = 0 /\ fatalPresent = FALSE
        /\ failureKind = "none" /\ failureValue = "none" /\ firstFatalValue = "none"
        /\ aborted = FALSE /\ result = "pending" /\ returnValue = "none"
        /\ stopActive = 0

ClaimBegin == /\ pc = "ready" /\ ~Stopped /\ active < 2 /\ pc' = "claim"
              /\ UNCHANGED <<active, fatalPresent, failureKind, failureValue, firstFatalValue, aborted, result,
                             returnValue, stopActive>>
ClaimReply(hasWork) ==
  /\ pc = "claim" /\ hasWork \in BOOLEAN
  /\ IF Stopped
       THEN /\ pc' = "draining" /\ UNCHANGED <<active, stopActive>>
       ELSE IF hasWork
         THEN /\ pc' = "ready" /\ active' = active + 1 /\ UNCHANGED stopActive
         ELSE /\ pc' = "backoff" /\ UNCHANGED <<active, stopActive>>
  /\ UNCHANGED <<fatalPresent, failureKind, failureValue, firstFatalValue, aborted, result, returnValue>>
ClaimFault == /\ pc = "claim" /\ pc' = "observer"
              /\ UNCHANGED <<active, fatalPresent, failureKind, failureValue, firstFatalValue, aborted, result,
                             returnValue, stopActive>>
ObserveHandled ==
  /\ pc = "observer" /\ pc' = (IF Stopped THEN "draining" ELSE "backoff")
  /\ UNCHANGED <<active, fatalPresent, failureKind, failureValue, firstFatalValue, aborted, result,
                 returnValue, stopActive>>
ObserveFatal(value) ==
  /\ pc = "observer" /\ value \in RunnerFailureValues
  /\ LET fatalNow == ~fatalPresent IN
       /\ fatalPresent' = TRUE
       /\ failureValue' = IF fatalNow THEN value ELSE failureValue
       /\ firstFatalValue' = IF fatalNow THEN value ELSE firstFatalValue
       /\ failureKind' = FailureKind(failureValue')
       /\ stopActive' = IF fatalNow /\ ~Stopped THEN active ELSE stopActive
  /\ pc' = "draining"
  /\ UNCHANGED <<active, aborted, result, returnValue>>
ActiveDone(failed, handled, value) ==
  /\ active > 0 /\ failed \in BOOLEAN /\ handled \in BOOLEAN
  /\ value \in RunnerFailureValues /\ active' = active - 1
  /\ LET fatalNow == failed /\ ~handled /\ ~aborted /\ ~fatalPresent IN
       /\ fatalPresent' = (fatalPresent \/ fatalNow)
       /\ failureValue' = IF fatalNow THEN value ELSE failureValue
       /\ firstFatalValue' = IF fatalNow THEN value ELSE firstFatalValue
       /\ failureKind' = FailureKind(failureValue')
       /\ stopActive' = IF fatalNow /\ ~Stopped THEN active - 1 ELSE stopActive
       /\ pc' = IF pc = "backoff"
                 THEN IF fatalPresent' \/ aborted THEN "draining" ELSE "ready"
                 ELSE pc
  /\ UNCHANGED <<aborted, result, returnValue>>
PollTimeout == /\ pc = "backoff" /\ pc' = "ready"
               /\ UNCHANGED <<active, fatalPresent, failureKind, failureValue, firstFatalValue, aborted, result,
                              returnValue, stopActive>>
Abort == /\ ~aborted /\ pc # "done" /\ aborted' = TRUE
         /\ pc' = IF pc \in {"ready", "backoff"} THEN "draining" ELSE pc
         /\ stopActive' = IF Stopped THEN stopActive ELSE active
         /\ UNCHANGED <<active, fatalPresent, failureKind, failureValue, firstFatalValue, result, returnValue>>
Drain == /\ pc = "ready" /\ Stopped /\ pc' = "draining"
         /\ UNCHANGED <<active, fatalPresent, failureKind, failureValue, firstFatalValue, aborted, result,
                        returnValue, stopActive>>
Finish == /\ pc = "draining" /\ active = 0 /\ pc' = "done"
          /\ result' = IF RunnerRejects(fatalPresent) THEN "rejected" ELSE "fulfilled"
          /\ returnValue' = IF fatalPresent THEN failureValue ELSE "none"
          /\ UNCHANGED <<active, fatalPresent, failureKind, failureValue, firstFatalValue, aborted, stopActive>>
Next == ClaimBegin \/ (\E hasWork \in BOOLEAN : ClaimReply(hasWork)) \/ ClaimFault
        \/ ObserveHandled \/ (\E value \in RunnerFailureValues : ObserveFatal(value))
        \/ (\E failed \in BOOLEAN, handled \in BOOLEAN, value \in RunnerFailureValues : ActiveDone(failed, handled, value))
        \/ PollTimeout \/ Abort \/ Drain \/ Finish
Spec == Init /\ [][Next]_vars

RuntimeTypeOK == /\ pc \in {"ready", "claim", "observer", "backoff", "draining", "done"}
                 /\ active \in 0..2 /\ fatalPresent \in BOOLEAN /\ aborted \in BOOLEAN
                 /\ failureKind \in {"none", "undefined", "defined"}
                 /\ failureValue \in RunnerFailureDomain /\ firstFatalValue \in RunnerFailureDomain /\ returnValue \in RunnerFailureDomain
                 /\ result \in {"pending", "rejected", "fulfilled"} /\ stopActive \in 0..2
FailurePresenceIndependent ==
  /\ fatalPresent = (failureValue # "none")
  /\ failureKind = FailureKind(failureValue)
FirstFatalValuePreserved ==
  /\ (fatalPresent => /\ firstFatalValue # "none" /\ failureValue = firstFatalValue)
  /\ (~fatalPresent => firstFatalValue = "none")
NoFatalBackoff == fatalPresent => pc # "backoff"
NoAdmissionAfterStop == Stopped => active <= stopActive
DrainedBeforeReturn == pc = "done" => active = 0
FatalReturnRejects == pc = "done" => (result = "rejected") = RunnerRejects(fatalPresent)
FatalValuePreserved == pc = "done" => returnValue = failureValue
AdapterSetFor(kind) == {sample.adapter : sample \in {candidate \in Samples : candidate.kind = kind}}
RuntimeCommonRunnerSites == {
  "firstFatal",
  "claim", "claimObserver", "active", "activeObserver",
  "handledClaim", "handledActive", "backoffBefore", "backoffDuring",
  "drain", "claimGate"
}
RuntimeExpectedRunnerModeSites ==
  {<<mode, site>> : mode \in RunnerModes, site \in RuntimeCommonRunnerSites}
  \cup {<<"local", "abortClaimReply">>, <<"local", "abortActive">>}
RuntimeRunnerModeSites ==
  {<<sample.mode, sample.site>> : sample \in {candidate \in Samples : candidate.kind = "runner"}}
RuntimeSamplesConform == /\ Samples # {}
                        /\ {s.kind : s \in Samples} = {"runner", "runnerHistory", "read", "readAdapter", "backoff", "budget", "cancel"}
                        /\ AdapterSetFor("readAdapter") = ReadAdapterDomain
                        /\ RuntimeRunnerModeSites = RuntimeExpectedRunnerModeSites
                        /\ \A s \in Samples : BoundarySampleOK(s)
=============================================================================
