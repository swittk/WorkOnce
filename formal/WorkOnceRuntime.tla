--------------------------- MODULE WorkOnceRuntime ---------------------------
EXTENDS Naturals, FiniteSets, WorkOnceContract
CONSTANT Samples
VARIABLES pc, active, fatalPresent, failureKind, aborted, result, stopActive
vars == <<pc, active, fatalPresent, failureKind, aborted, result, stopActive>>
Stopped == fatalPresent \/ aborted
Init == /\ pc = "ready" /\ active = 0 /\ fatalPresent = FALSE
        /\ failureKind = "none" /\ aborted = FALSE /\ result = "pending"
        /\ stopActive = 0

ClaimBegin == /\ pc = "ready" /\ ~Stopped /\ active < 2 /\ pc' = "claim"
              /\ UNCHANGED <<active, fatalPresent, failureKind, aborted, result, stopActive>>
ClaimReply(hasWork) ==
  /\ pc = "claim" /\ hasWork \in BOOLEAN
  /\ IF Stopped
       THEN /\ pc' = "draining" /\ UNCHANGED <<active, stopActive>>
       ELSE IF hasWork
         THEN /\ pc' = "ready" /\ active' = active + 1 /\ UNCHANGED stopActive
         ELSE /\ pc' = "backoff" /\ UNCHANGED <<active, stopActive>>
  /\ UNCHANGED <<fatalPresent, failureKind, aborted, result>>
ClaimFault == /\ pc = "claim" /\ pc' = "observer"
              /\ UNCHANGED <<active, fatalPresent, failureKind, aborted, result, stopActive>>
ObserveHandled ==
  /\ pc = "observer" /\ pc' = (IF Stopped THEN "draining" ELSE "backoff")
  /\ UNCHANGED <<active, fatalPresent, failureKind, aborted, result, stopActive>>
ObserveFatal(kind) ==
  /\ pc = "observer" /\ kind \in {"undefined", "defined"}
  /\ fatalPresent' = TRUE /\ failureKind' = kind /\ pc' = "draining"
  /\ stopActive' = IF Stopped THEN stopActive ELSE active
  /\ UNCHANGED <<active, aborted, result>>
ActiveDone(failed, handled, kind) ==
  /\ active > 0 /\ failed \in BOOLEAN /\ handled \in BOOLEAN
  /\ kind \in {"undefined", "defined"} /\ active' = active - 1
  /\ LET fatalNow == failed /\ ~handled /\ ~aborted IN
       /\ fatalPresent' = (fatalPresent \/ fatalNow)
       /\ failureKind' = IF fatalNow THEN kind ELSE failureKind
       /\ stopActive' = IF fatalNow /\ ~Stopped THEN active - 1 ELSE stopActive
       /\ pc' = IF pc = "backoff"
                 THEN IF fatalPresent' \/ aborted THEN "draining" ELSE "ready"
                 ELSE pc
  /\ UNCHANGED <<aborted, result>>
PollTimeout == /\ pc = "backoff" /\ pc' = "ready"
               /\ UNCHANGED <<active, fatalPresent, failureKind, aborted, result, stopActive>>
Abort == /\ ~aborted /\ pc # "done" /\ aborted' = TRUE
         /\ pc' = IF pc \in {"ready", "backoff"} THEN "draining" ELSE pc
         /\ stopActive' = IF Stopped THEN stopActive ELSE active
         /\ UNCHANGED <<active, fatalPresent, failureKind, result>>
Drain == /\ pc = "ready" /\ Stopped /\ pc' = "draining"
         /\ UNCHANGED <<active, fatalPresent, failureKind, aborted, result, stopActive>>
Finish == /\ pc = "draining" /\ active = 0 /\ pc' = "done"
          /\ result' = IF RunnerRejects(fatalPresent) THEN "rejected" ELSE "fulfilled"
          /\ UNCHANGED <<active, fatalPresent, failureKind, aborted, stopActive>>
Next == ClaimBegin \/ (\E hasWork \in BOOLEAN : ClaimReply(hasWork)) \/ ClaimFault
        \/ ObserveHandled \/ (\E kind \in {"undefined", "defined"} : ObserveFatal(kind))
        \/ (\E failed \in BOOLEAN, handled \in BOOLEAN, kind \in {"undefined", "defined"} : ActiveDone(failed, handled, kind))
        \/ PollTimeout \/ Abort \/ Drain \/ Finish
Spec == Init /\ [][Next]_vars

RuntimeTypeOK == /\ pc \in {"ready", "claim", "observer", "backoff", "draining", "done"}
                 /\ active \in 0..2 /\ fatalPresent \in BOOLEAN /\ aborted \in BOOLEAN
                 /\ failureKind \in {"none", "undefined", "defined"}
                 /\ result \in {"pending", "rejected", "fulfilled"} /\ stopActive \in 0..2
FailurePresenceIndependent == fatalPresent = (failureKind # "none")
NoFatalBackoff == fatalPresent => pc # "backoff"
NoAdmissionAfterStop == Stopped => active <= stopActive
DrainedBeforeReturn == pc = "done" => active = 0
FatalReturnRejects == pc = "done" => (result = "rejected") = RunnerRejects(fatalPresent)
RuntimeSamplesConform == /\ Samples # {}
                        /\ {s.kind : s \in Samples} = {"runner", "read", "backoff", "budget", "cancel"}
                        /\ \A s \in Samples : BoundarySampleOK(s)
=============================================================================
