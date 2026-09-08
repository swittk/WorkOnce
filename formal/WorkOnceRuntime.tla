--------------------------- MODULE WorkOnceRuntime ---------------------------
EXTENDS Naturals, FiniteSets, WorkOnceContract
CONSTANT Samples
VARIABLES pc, active, fatalPresent, failureKind, aborted, result, badAdmission
vars == <<pc, active, fatalPresent, failureKind, aborted, result, badAdmission>>
Stopped == fatalPresent \/ aborted
Init == /\ pc = "ready" /\ active = 0 /\ fatalPresent = FALSE
        /\ failureKind = "none" /\ aborted = FALSE /\ result = "pending"
        /\ badAdmission = FALSE

ClaimBegin == /\ pc = "ready" /\ ~Stopped /\ active < 2 /\ pc' = "claim"
              /\ UNCHANGED <<active, fatalPresent, failureKind, aborted, result, badAdmission>>
ClaimReply(hasWork) ==
  /\ pc = "claim" /\ hasWork \in BOOLEAN
  /\ IF Stopped
       THEN /\ pc' = "draining" /\ UNCHANGED <<active, badAdmission>>
       ELSE IF hasWork
         THEN /\ pc' = "ready" /\ active' = active + 1 /\ badAdmission' = Stopped
         ELSE /\ pc' = "backoff" /\ UNCHANGED <<active, badAdmission>>
  /\ UNCHANGED <<fatalPresent, failureKind, aborted, result>>
ClaimFault == /\ pc = "claim" /\ pc' = "observer"
              /\ UNCHANGED <<active, fatalPresent, failureKind, aborted, result, badAdmission>>
ObserveHandled ==
  /\ pc = "observer" /\ pc' = (IF Stopped THEN "draining" ELSE "backoff")
  /\ UNCHANGED <<active, fatalPresent, failureKind, aborted, result, badAdmission>>
ObserveFatal(kind) ==
  /\ pc = "observer" /\ kind \in {"undefined", "defined"}
  /\ fatalPresent' = TRUE /\ failureKind' = kind /\ pc' = "draining"
  /\ UNCHANGED <<active, aborted, result, badAdmission>>
ActiveDone(failed, handled, kind) ==
  /\ active > 0 /\ failed \in BOOLEAN /\ handled \in BOOLEAN
  /\ kind \in {"undefined", "defined"} /\ active' = active - 1
  /\ LET fatalNow == failed /\ ~handled /\ ~aborted IN
       /\ fatalPresent' = (fatalPresent \/ fatalNow)
       /\ failureKind' = IF fatalNow THEN kind ELSE failureKind
       /\ pc' = IF pc = "backoff"
                 THEN IF fatalPresent' \/ aborted THEN "draining" ELSE "ready"
                 ELSE pc
  /\ UNCHANGED <<aborted, result, badAdmission>>
PollTimeout == /\ pc = "backoff" /\ pc' = "ready"
               /\ UNCHANGED <<active, fatalPresent, failureKind, aborted, result, badAdmission>>
Abort == /\ ~aborted /\ pc # "done" /\ aborted' = TRUE
         /\ pc' = IF pc \in {"ready", "backoff"} THEN "draining" ELSE pc
         /\ UNCHANGED <<active, fatalPresent, failureKind, result, badAdmission>>
Drain == /\ pc = "ready" /\ Stopped /\ pc' = "draining"
         /\ UNCHANGED <<active, fatalPresent, failureKind, aborted, result, badAdmission>>
Finish == /\ pc = "draining" /\ active = 0 /\ pc' = "done"
          /\ result' = IF RunnerRejects(fatalPresent) THEN "rejected" ELSE "fulfilled"
          /\ UNCHANGED <<active, fatalPresent, failureKind, aborted, badAdmission>>
Next == ClaimBegin \/ (\E hasWork \in BOOLEAN : ClaimReply(hasWork)) \/ ClaimFault
        \/ ObserveHandled \/ (\E kind \in {"undefined", "defined"} : ObserveFatal(kind))
        \/ (\E failed \in BOOLEAN, handled \in BOOLEAN, kind \in {"undefined", "defined"} : ActiveDone(failed, handled, kind))
        \/ PollTimeout \/ Abort \/ Drain \/ Finish
Spec == Init /\ [][Next]_vars

RuntimeTypeOK == /\ pc \in {"ready", "claim", "observer", "backoff", "draining", "done"}
                 /\ active \in 0..2 /\ fatalPresent \in BOOLEAN /\ aborted \in BOOLEAN
                 /\ failureKind \in {"none", "undefined", "defined"}
                 /\ result \in {"pending", "rejected", "fulfilled"} /\ badAdmission \in BOOLEAN
FailurePresenceIndependent == fatalPresent = (failureKind # "none")
NoFatalBackoff == fatalPresent => pc # "backoff"
NoAdmissionAfterStop == ~badAdmission
DrainedBeforeReturn == pc = "done" => active = 0
FatalReturnRejects == pc = "done" => (result = "rejected") = RunnerRejects(fatalPresent)
RuntimeSamplesConform == /\ Samples # {}
                        /\ {s.kind : s \in Samples} = {"runner", "read", "backoff", "budget", "cancel"}
                        /\ \A s \in Samples : BoundarySampleOK(s)
=============================================================================
