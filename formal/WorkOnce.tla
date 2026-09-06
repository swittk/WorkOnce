------------------------------ MODULE WorkOnce ------------------------------
EXTENDS Naturals, FiniteSets
CONSTANTS Workers, MaxTime, MaxFence, MaxGeneration, MaxAttempts, MaxRetries
VARIABLES state, owner, fence, generation, lease, now, available, attempts,
          retries, tokens, pendingNext, childCreated, lastAcceptedFence
vars == <<state, owner, fence, generation, lease, now, available, attempts,
          retries, tokens, pendingNext, childCreated, lastAcceptedFence>>
Init == /\ state = "queued" /\ owner = 0 /\ fence = 0 /\ generation = 1
        /\ lease = 0 /\ now = 0 /\ available = 0 /\ attempts = 0 /\ retries = 0
        /\ tokens = {}
        /\ pendingNext = FALSE /\ childCreated = FALSE /\ lastAcceptedFence = 0
Current(t) == /\ state = "running" /\ owner = t.worker /\ now < lease
              /\ t.generation = generation /\ t.fence = fence
Due == \/ /\ state \in {"queued", "waiting"} /\ available <= now
       \/ /\ state = "running" /\ lease <= now
Claim(w) == /\ Due /\ attempts < MaxAttempts /\ fence < MaxFence
            /\ state' = "running" /\ owner' = w /\ fence' = fence + 1
            /\ lease' = now + 1 /\ attempts' = attempts + 1
            /\ tokens' = tokens \cup {[worker |-> w, generation |-> generation, fence |-> fence+1]}
            /\ UNCHANGED <<generation, now, available, retries, pendingNext, childCreated, lastAcceptedFence>>
Renew(t) == /\ Current(t) /\ lease' = now + 1
            /\ UNCHANGED <<state, owner, fence, generation, now, available, attempts, retries, tokens, pendingNext, childCreated, lastAcceptedFence>>
Success(t) == /\ Current(t) /\ state' = "succeeded" /\ owner' = 0
              /\ pendingNext' = TRUE /\ lastAcceptedFence' = t.fence
              /\ UNCHANGED <<fence, generation, lease, now, available, attempts, retries, tokens, childCreated>>
Fail(t) == /\ Current(t) /\ state' = "failed" /\ owner' = 0
           /\ lastAcceptedFence' = t.fence
           /\ UNCHANGED <<fence, generation, lease, now, available, attempts, retries, tokens, pendingNext, childCreated>>
Retry(t) == /\ Current(t) /\ owner' = 0 /\ lastAcceptedFence' = t.fence
            /\ IF retries < MaxRetries /\ attempts < MaxAttempts
               THEN /\ state' = "waiting" /\ retries' = retries + 1 /\ available' = now + 1
               ELSE /\ state' = "failed" /\ UNCHANGED <<retries, available>>
            /\ UNCHANGED <<fence, generation, lease, now, attempts, tokens, pendingNext, childCreated>>
Cancel == /\ state \in {"queued", "running", "waiting"} /\ state' = "cancelled" /\ owner' = 0
          /\ UNCHANGED <<fence, generation, lease, now, available, attempts, retries, tokens, pendingNext, childCreated, lastAcceptedFence>>
ManualRetry == /\ state = "failed" /\ generation < MaxGeneration
               /\ generation' = generation + 1 /\ state' = "queued" /\ available' = now
               /\ attempts' = 0 /\ retries' = 0
               /\ UNCHANGED <<owner, fence, lease, now, tokens, pendingNext, childCreated, lastAcceptedFence>>
Exhaust == /\ Due /\ attempts >= MaxAttempts /\ state' = "failed" /\ owner' = 0
           /\ UNCHANGED <<fence, generation, lease, now, available, attempts, retries, tokens, pendingNext, childCreated, lastAcceptedFence>>
CreateChild == /\ pendingNext /\ childCreated' = TRUE
               /\ UNCHANGED <<state, owner, fence, generation, lease, now, available, attempts, retries, tokens, pendingNext, lastAcceptedFence>>
AckChild == /\ pendingNext /\ childCreated /\ pendingNext' = FALSE
            /\ UNCHANGED <<state, owner, fence, generation, lease, now, available, attempts, retries, tokens, childCreated, lastAcceptedFence>>
Tick == /\ now < MaxTime /\ now' = now + 1
        /\ UNCHANGED <<state, owner, fence, generation, lease, available, attempts, retries, tokens, pendingNext, childCreated, lastAcceptedFence>>
Next == (\E w \in Workers : Claim(w))
        \/ (\E t \in tokens : Renew(t) \/ Success(t) \/ Fail(t) \/ Retry(t))
        \/ Cancel \/ ManualRetry \/ Exhaust \/ CreateChild \/ AckChild \/ Tick
Spec == Init /\ [][Next]_vars
TypeOK == /\ state \in {"queued", "running", "waiting", "failed", "cancelled", "succeeded"}
          /\ fence \in 0..MaxFence /\ generation \in 1..MaxGeneration
          /\ owner \in Workers \cup {0}
          /\ attempts \in 0..MaxAttempts /\ retries \in 0..MaxRetries
OneOwner == Cardinality({t \in tokens : Current(t)}) <= 1
SuccessUsesCurrentFence == state = "succeeded" => lastAcceptedFence = fence
AcceptedFenceNotFromFuture == lastAcceptedFence <= fence
NoLostContinuation == state = "succeeded" => pendingNext \/ childCreated
NoOrphanContinuation == childCreated => state = "succeeded"
=============================================================================
