------------------------------ MODULE WorkOnce ------------------------------
EXTENDS Naturals, FiniteSets, Integers
CONSTANTS Workers, MaxTime, MaxFence, MaxGeneration, MaxAttempts, MaxRetries, MaxDeferrals, MaxElapsed
VARIABLES state, waitCause, owner, fence, generation, lease, now, available,
          attempts, retries, deferrals, firstStarted, manualRetryAllowed, stopReason,
          tokens, pendingNext, childCreated, terminalNeedsNext, lastAcceptedFence
vars == <<state, waitCause, owner, fence, generation, lease, now, available,
          attempts, retries, deferrals, firstStarted, manualRetryAllowed, stopReason,
          tokens, pendingNext, childCreated, terminalNeedsNext, lastAcceptedFence>>

Min2(a, b) == IF a <= b THEN a ELSE b
Deadline == IF firstStarted = -1 THEN MaxTime + MaxElapsed + 1 ELSE firstStarted + MaxElapsed
Init == /\ state = "queued" /\ waitCause = "none" /\ owner = 0
        /\ fence = 0 /\ generation = 1 /\ lease = 0 /\ now = 0 /\ available = 0
        /\ attempts = 0 /\ retries = 0 /\ deferrals = 0 /\ firstStarted = -1
        /\ manualRetryAllowed = FALSE /\ stopReason = "none" /\ tokens = {}
        /\ pendingNext = FALSE /\ childCreated = FALSE /\ terminalNeedsNext = FALSE
        /\ lastAcceptedFence = 0
Current(t) == /\ state = "running" /\ owner = t.worker /\ now < lease
              /\ t.generation = generation /\ t.fence = fence
Due == \/ /\ state \in {"queued", "waiting"} /\ available <= now
       \/ /\ state = "running" /\ lease <= now
WithinElapsedBudget == firstStarted = -1 \/ now < Deadline

Claim(w) ==
  /\ Due /\ attempts < MaxAttempts /\ fence < MaxFence /\ WithinElapsedBudget
  /\ LET started == IF firstStarted = -1 THEN now ELSE firstStarted IN
       /\ state' = "running" /\ waitCause' = "none" /\ owner' = w
       /\ fence' = fence + 1 /\ firstStarted' = started
       /\ lease' = Min2(now + 1, started + MaxElapsed)
       /\ attempts' = attempts + 1
       /\ tokens' = tokens \cup {[worker |-> w, generation |-> generation, fence |-> fence+1]}
  /\ manualRetryAllowed' = FALSE /\ stopReason' = "none" /\ lastAcceptedFence' = 0
  /\ UNCHANGED <<generation, now, available, retries, deferrals, pendingNext,
                 childCreated, terminalNeedsNext>>
Renew(t) ==
  /\ Current(t)
  /\ lease' = Min2(now + 1, Deadline)
  /\ UNCHANGED <<state, waitCause, owner, fence, generation, now, available,
                 attempts, retries, deferrals, firstStarted, manualRetryAllowed,
                 stopReason, tokens, pendingNext, childCreated, terminalNeedsNext,
                 lastAcceptedFence>>
Success(t, withNext) ==
  /\ Current(t) /\ withNext \in BOOLEAN
  /\ state' = "succeeded" /\ waitCause' = "none" /\ owner' = 0
  /\ pendingNext' = withNext /\ terminalNeedsNext' = withNext
  /\ manualRetryAllowed' = FALSE /\ stopReason' = "none"
  /\ lastAcceptedFence' = t.fence
  /\ UNCHANGED <<fence, generation, lease, now, available, attempts, retries,
                 deferrals, firstStarted, tokens, childCreated>>
Fail(t, withNext, allowManual) ==
  /\ Current(t) /\ withNext \in BOOLEAN /\ allowManual \in BOOLEAN
  /\ state' = "failed" /\ waitCause' = "none" /\ owner' = 0
  /\ pendingNext' = withNext /\ terminalNeedsNext' = withNext
  /\ manualRetryAllowed' = allowManual /\ stopReason' = "reported_failure"
  /\ lastAcceptedFence' = t.fence
  /\ UNCHANGED <<fence, generation, lease, now, available, attempts, retries,
                 deferrals, firstStarted, tokens, childCreated>>
Retry(t, policyAllows, allowManual) ==
  /\ Current(t) /\ policyAllows \in BOOLEAN /\ allowManual \in BOOLEAN
  /\ owner' = 0 /\ waitCause' = IF policyAllows /\ retries < MaxRetries /\ attempts < MaxAttempts /\ now + 1 < Deadline THEN "retry" ELSE "none"
  /\ lastAcceptedFence' = t.fence /\ pendingNext' = FALSE /\ terminalNeedsNext' = FALSE
  /\ IF ~policyAllows
        THEN /\ state' = "failed" /\ manualRetryAllowed' = allowManual /\ stopReason' = "retry_not_allowed" /\ UNCHANGED <<retries, available>>
      ELSE IF retries >= MaxRetries
        THEN /\ state' = "failed" /\ manualRetryAllowed' = allowManual /\ stopReason' = "retry_budget_exhausted" /\ UNCHANGED <<retries, available>>
      ELSE IF attempts >= MaxAttempts
        THEN /\ state' = "failed" /\ manualRetryAllowed' = allowManual /\ stopReason' = "attempt_budget_exhausted" /\ UNCHANGED <<retries, available>>
      ELSE IF now + 1 >= Deadline
        THEN /\ state' = "failed" /\ manualRetryAllowed' = allowManual /\ stopReason' = "deadline_exceeded" /\ UNCHANGED <<retries, available>>
      ELSE /\ state' = "waiting" /\ retries' = retries + 1 /\ available' = now + 1
           /\ manualRetryAllowed' = FALSE /\ stopReason' = "none"
  /\ UNCHANGED <<fence, generation, lease, now, attempts, deferrals, firstStarted, tokens, childCreated>>
Defer(t) ==
  /\ Current(t) /\ owner' = 0
  /\ waitCause' = IF deferrals < MaxDeferrals /\ attempts < MaxAttempts /\ now + 1 < Deadline THEN "defer" ELSE "none"
  /\ lastAcceptedFence' = t.fence /\ pendingNext' = FALSE /\ terminalNeedsNext' = FALSE
  /\ IF deferrals >= MaxDeferrals
        THEN /\ state' = "failed" /\ manualRetryAllowed' = TRUE /\ stopReason' = "deferral_budget_exhausted" /\ UNCHANGED <<deferrals, available>>
      ELSE IF attempts >= MaxAttempts
        THEN /\ state' = "failed" /\ manualRetryAllowed' = TRUE /\ stopReason' = "attempt_budget_exhausted" /\ UNCHANGED <<deferrals, available>>
      ELSE IF now + 1 >= Deadline
        THEN /\ state' = "failed" /\ manualRetryAllowed' = TRUE /\ stopReason' = "deadline_exceeded" /\ UNCHANGED <<deferrals, available>>
      ELSE /\ state' = "waiting" /\ deferrals' = deferrals + 1 /\ available' = now + 1
           /\ manualRetryAllowed' = FALSE /\ stopReason' = "none"
  /\ UNCHANGED <<fence, generation, lease, now, attempts, retries, firstStarted, tokens, childCreated>>
Cancel ==
  /\ state \in {"queued", "running", "waiting"}
  /\ state' = "cancelled" /\ waitCause' = "none" /\ owner' = 0
  /\ pendingNext' = FALSE /\ terminalNeedsNext' = FALSE
  /\ manualRetryAllowed' = FALSE /\ stopReason' = "none"
  /\ UNCHANGED <<fence, generation, lease, now, available, attempts, retries,
                 deferrals, firstStarted, tokens, childCreated, lastAcceptedFence>>
Wake ==
  /\ state \in {"queued", "waiting"}
  /\ available' = now
  /\ UNCHANGED <<state, waitCause, owner, fence, generation, lease, now, attempts,
                 retries, deferrals, firstStarted, manualRetryAllowed, stopReason,
                 tokens, pendingNext, childCreated, terminalNeedsNext, lastAcceptedFence>>
ManualRetry ==
  /\ state = "failed" /\ manualRetryAllowed /\ pendingNext = FALSE /\ generation < MaxGeneration
  /\ generation' = generation + 1 /\ state' = "queued" /\ waitCause' = "none"
  /\ available' = now /\ attempts' = 0 /\ retries' = 0 /\ deferrals' = 0 /\ firstStarted' = -1
  /\ manualRetryAllowed' = FALSE /\ stopReason' = "none" /\ terminalNeedsNext' = FALSE
  /\ childCreated' = FALSE /\ lastAcceptedFence' = 0
  /\ UNCHANGED <<owner, fence, lease, now, tokens, pendingNext>>
Rerun ==
  /\ state = "succeeded" /\ pendingNext = FALSE /\ generation < MaxGeneration
  /\ generation' = generation + 1 /\ state' = "queued" /\ waitCause' = "none"
  /\ available' = now /\ attempts' = 0 /\ retries' = 0 /\ deferrals' = 0 /\ firstStarted' = -1
  /\ manualRetryAllowed' = FALSE /\ stopReason' = "none" /\ terminalNeedsNext' = FALSE
  /\ childCreated' = FALSE /\ lastAcceptedFence' = 0
  /\ UNCHANGED <<owner, fence, lease, now, tokens, pendingNext>>
ExhaustAttempts ==
  /\ Due /\ attempts >= MaxAttempts
  /\ state' = "failed" /\ waitCause' = "none" /\ owner' = 0
  /\ pendingNext' = FALSE /\ terminalNeedsNext' = FALSE
  /\ manualRetryAllowed' = TRUE /\ stopReason' = "attempt_budget_exhausted"
  /\ UNCHANGED <<fence, generation, lease, now, available, attempts, retries,
                 deferrals, firstStarted, tokens, childCreated, lastAcceptedFence>>
ExhaustDeadline ==
  /\ Due /\ attempts < MaxAttempts /\ firstStarted # -1 /\ now >= Deadline
  /\ state' = "failed" /\ waitCause' = "none" /\ owner' = 0
  /\ pendingNext' = FALSE /\ terminalNeedsNext' = FALSE
  /\ manualRetryAllowed' = TRUE /\ stopReason' = "deadline_exceeded"
  /\ UNCHANGED <<fence, generation, lease, now, available, attempts, retries,
                 deferrals, firstStarted, tokens, childCreated, lastAcceptedFence>>
CreateChild ==
  /\ pendingNext /\ childCreated' = TRUE
  /\ UNCHANGED <<state, waitCause, owner, fence, generation, lease, now, available,
                 attempts, retries, deferrals, firstStarted, manualRetryAllowed, stopReason,
                 tokens, pendingNext, terminalNeedsNext, lastAcceptedFence>>
AckChild ==
  /\ pendingNext /\ childCreated
  /\ pendingNext' = FALSE /\ terminalNeedsNext' = FALSE
  /\ UNCHANGED <<state, waitCause, owner, fence, generation, lease, now, available,
                 attempts, retries, deferrals, firstStarted, manualRetryAllowed, stopReason,
                 tokens, childCreated, lastAcceptedFence>>
Tick ==
  /\ now < MaxTime /\ now' = now + 1
  /\ UNCHANGED <<state, waitCause, owner, fence, generation, lease, available,
                 attempts, retries, deferrals, firstStarted, manualRetryAllowed, stopReason,
                 tokens, pendingNext, childCreated, terminalNeedsNext, lastAcceptedFence>>

Next == (\E w \in Workers : Claim(w))
        \/ (\E t \in tokens : Renew(t) \/ Defer(t)
             \/ (\E policyAllows \in BOOLEAN, allowManual \in BOOLEAN : Retry(t, policyAllows, allowManual))
             \/ (\E withNext \in BOOLEAN : Success(t, withNext))
             \/ (\E withNext \in BOOLEAN, allowManual \in BOOLEAN : Fail(t, withNext, allowManual)))
        \/ Cancel \/ Wake \/ ManualRetry \/ Rerun \/ ExhaustAttempts \/ ExhaustDeadline
        \/ CreateChild \/ AckChild \/ Tick
Spec == Init /\ [][Next]_vars

TypeOK == /\ state \in {"queued", "running", "waiting", "failed", "cancelled", "succeeded"}
          /\ waitCause \in {"none", "retry", "defer"}
          /\ stopReason \in {"none", "reported_failure", "retry_not_allowed", "retry_budget_exhausted",
                              "attempt_budget_exhausted", "deadline_exceeded", "deferral_budget_exhausted"}
          /\ fence \in 0..MaxFence /\ generation \in 1..MaxGeneration
          /\ owner \in Workers \cup {0}
          /\ attempts \in 0..MaxAttempts /\ retries \in 0..MaxRetries
          /\ deferrals \in 0..MaxDeferrals /\ firstStarted \in {-1} \cup 0..MaxTime
          /\ lastAcceptedFence \in 0..MaxFence
CurrentFenceUnique == Cardinality({t \in tokens : t.generation = generation /\ t.fence = fence}) <= 1
RunningOwnerTokenIssued == state = "running" =>
  [worker |-> owner, generation |-> generation, fence |-> fence] \in tokens
AcceptedFenceIsCurrentOrClear == lastAcceptedFence = 0 \/ lastAcceptedFence = fence
SuccessUsesCurrentFence == state = "succeeded" => lastAcceptedFence = fence
WaitingHasCause == state = "waiting" => waitCause \in {"retry", "defer"}
RunningHasNoWaitCause == state = "running" => waitCause = "none"
PendingFollowupIsTerminal == pendingNext => state \in {"succeeded", "failed"}
ResetStatesHaveNoPendingFollowup == state \in {"queued", "running", "waiting"} => ~pendingNext
NoLostContinuation == terminalNeedsNext => pendingNext \/ childCreated
=============================================================================
