---------------------- MODULE WorkOnceLifecycleTemporal ----------------------
EXTENDS Naturals
CONSTANTS MaxRevision, MaxFence, MaxGeneration
VARIABLES phase, revision, generation, fence,
          receiptGeneration, receiptFence, receiptHash,
          lastOp, lastResult, lastBeforeRevision, lastBeforePhase,
          lastExpectedRevision, lastRefGeneration, lastRefFence, lastHash
vars == <<phase, revision, generation, fence,
          receiptGeneration, receiptFence, receiptHash,
          lastOp, lastResult, lastBeforeRevision, lastBeforePhase,
          lastExpectedRevision, lastRefGeneration, lastRefFence, lastHash>>
Hashes == {"none", "h1", "h2"}
Phases == {"queued", "running", "waiting", "succeeded", "failed", "cancelled"}
Results == {"none", "ok", "replay", "conflict", "stale", "generation_conflict"}
Ops == {"none", "claim", "renew", "settle", "defer", "wake", "cancel", "cancel_terminal", "reset", "replay"}
Terminal == phase \in {"succeeded", "failed", "cancelled"}

Init ==
  /\ phase = "queued"
  /\ revision = 1
  /\ generation = 1
  /\ fence = 0
  /\ receiptGeneration = 0 /\ receiptFence = 0 /\ receiptHash = "none"
  /\ lastOp = "none" /\ lastResult = "none"
  /\ lastBeforeRevision = 1 /\ lastBeforePhase = "queued"
  /\ lastExpectedRevision = 0 /\ lastRefGeneration = 0 /\ lastRefFence = 0
  /\ lastHash = "none"

Record(op, result) ==
  /\ lastOp' = op /\ lastResult' = result
  /\ lastBeforeRevision' = revision /\ lastBeforePhase' = phase

Claim ==
  /\ phase \in {"queued", "waiting", "running"}
  /\ revision < MaxRevision /\ fence < MaxFence
  /\ Record("claim", "ok")
  /\ phase' = "running" /\ revision' = revision + 1 /\ fence' = fence + 1
  /\ UNCHANGED <<generation, receiptGeneration, receiptFence, receiptHash,
                 lastExpectedRevision, lastRefGeneration, lastRefFence, lastHash>>

Renew ==
  /\ phase = "running" /\ revision < MaxRevision
  /\ Record("renew", "ok")
  /\ revision' = revision + 1
  /\ UNCHANGED <<phase, generation, fence, receiptGeneration, receiptFence, receiptHash,
                 lastExpectedRevision, lastRefGeneration, lastRefFence, lastHash>>

Settle(kind, hash) ==
  /\ phase = "running" /\ kind \in {"succeeded", "failed"} /\ hash \in {"h1", "h2"}
  /\ revision < MaxRevision
  /\ Record("settle", "ok")
  /\ phase' = kind /\ revision' = revision + 1
  /\ receiptGeneration' = generation /\ receiptFence' = fence /\ receiptHash' = hash
  /\ lastHash' = hash
  /\ UNCHANGED <<generation, fence, lastExpectedRevision, lastRefGeneration, lastRefFence>>

Defer ==
  /\ phase = "running" /\ revision < MaxRevision
  /\ Record("defer", "ok")
  /\ phase' = "waiting" /\ revision' = revision + 1
  /\ UNCHANGED <<generation, fence, receiptGeneration, receiptFence, receiptHash,
                 lastExpectedRevision, lastRefGeneration, lastRefFence, lastHash>>

Wake(expectedRevision) ==
  /\ phase \in {"queued", "waiting"}
  /\ expectedRevision \in 1..MaxRevision
  /\ revision < MaxRevision
  /\ Record("wake", IF expectedRevision = revision THEN "ok" ELSE "generation_conflict")
  /\ lastExpectedRevision' = expectedRevision
  /\ IF expectedRevision = revision
       THEN revision' = revision + 1
       ELSE UNCHANGED revision
  /\ UNCHANGED <<phase, generation, fence, receiptGeneration, receiptFence, receiptHash,
                 lastRefGeneration, lastRefFence, lastHash>>

Cancel ==
  /\ ~Terminal /\ revision < MaxRevision
  /\ Record("cancel", "ok")
  /\ phase' = "cancelled" /\ revision' = revision + 1
  /\ UNCHANGED <<generation, fence, receiptGeneration, receiptFence, receiptHash,
                 lastExpectedRevision, lastRefGeneration, lastRefFence, lastHash>>

CancelTerminal ==
  /\ Terminal
  /\ Record("cancel_terminal", "ok")
  /\ UNCHANGED <<phase, revision, generation, fence, receiptGeneration, receiptFence, receiptHash,
                 lastExpectedRevision, lastRefGeneration, lastRefFence, lastHash>>

Reset ==
  /\ phase \in {"succeeded", "failed"}
  /\ generation < MaxGeneration /\ revision < MaxRevision
  /\ Record("reset", "ok")
  /\ phase' = "queued" /\ revision' = revision + 1 /\ generation' = generation + 1
  /\ receiptGeneration' = 0 /\ receiptFence' = 0 /\ receiptHash' = "none"
  /\ UNCHANGED <<fence, lastExpectedRevision, lastRefGeneration, lastRefFence, lastHash>>

Replay(refGeneration, refFence, hash) ==
  /\ refGeneration \in 1..MaxGeneration /\ refFence \in 1..MaxFence
  /\ hash \in {"h1", "h2"}
  /\ Record("replay",
       IF refGeneration # generation
         THEN "stale"
       ELSE IF receiptGeneration = refGeneration /\ receiptFence = refFence /\ receiptHash # "none"
         THEN IF hash = receiptHash THEN "replay" ELSE "conflict"
         ELSE "stale")
  /\ lastRefGeneration' = refGeneration /\ lastRefFence' = refFence /\ lastHash' = hash
  /\ UNCHANGED <<phase, revision, generation, fence, receiptGeneration, receiptFence, receiptHash,
                 lastExpectedRevision>>

Next == Claim \/ Renew
        \/ (\E kind \in {"succeeded", "failed"}, hash \in {"h1", "h2"} : Settle(kind, hash))
        \/ Defer
        \/ (\E expectedRevision \in 1..MaxRevision : Wake(expectedRevision))
        \/ Cancel \/ CancelTerminal \/ Reset
        \/ (\E refGeneration \in 1..MaxGeneration, refFence \in 1..MaxFence,
                hash \in {"h1", "h2"} : Replay(refGeneration, refFence, hash))
Spec == Init /\ [][Next]_vars

LifecycleTemporalTypeOK ==
  /\ phase \in Phases /\ revision \in 1..MaxRevision
  /\ generation \in 1..MaxGeneration /\ fence \in 0..MaxFence
  /\ receiptGeneration \in 0..MaxGeneration /\ receiptFence \in 0..MaxFence
  /\ receiptHash \in Hashes /\ lastHash \in Hashes
  /\ lastOp \in Ops /\ lastResult \in Results
  /\ lastBeforeRevision \in 1..MaxRevision /\ lastBeforePhase \in Phases
  /\ lastExpectedRevision \in 0..MaxRevision
  /\ lastRefGeneration \in 0..MaxGeneration /\ lastRefFence \in 0..MaxFence

AcceptedWakeUsesCurrentRevision ==
  lastOp = "wake" /\ lastResult = "ok" =>
    /\ lastExpectedRevision = lastBeforeRevision
    /\ revision = lastBeforeRevision + 1

AcceptedDeferProducesWaiting ==
  lastOp = "defer" /\ lastResult = "ok" =>
    /\ lastBeforePhase = "running"
    /\ phase = "waiting"
    /\ revision = lastBeforeRevision + 1

RejectedWakeDoesNotWrite ==
  lastOp = "wake" /\ lastResult = "generation_conflict" =>
    /\ revision = lastBeforeRevision
    /\ phase = lastBeforePhase

RejectedWakeUsesStaleRevision ==
  lastOp = "wake" /\ lastResult = "generation_conflict" =>
    lastExpectedRevision # lastBeforeRevision

TerminalCancelDoesNotWrite ==
  lastOp = "cancel_terminal" =>
    /\ revision = lastBeforeRevision
    /\ phase = lastBeforePhase

ResetClearsReceipt ==
  lastOp = "reset" /\ lastResult = "ok" =>
    /\ receiptGeneration = 0 /\ receiptFence = 0 /\ receiptHash = "none"

ReceiptBelongsToCurrentGeneration ==
  receiptHash # "none" =>
    /\ receiptGeneration = generation
    /\ receiptFence > 0 /\ receiptFence <= fence

ReplayUsesReceiptIdentity ==
  lastOp = "replay" =>
    CASE lastResult = "replay" ->
         /\ lastRefGeneration = generation
         /\ receiptGeneration = generation
         /\ lastRefFence = receiptFence
         /\ lastHash = receiptHash /\ receiptHash # "none"
      [] lastResult = "conflict" ->
         /\ lastRefGeneration = generation
         /\ receiptGeneration = generation
         /\ lastRefFence = receiptFence
         /\ lastHash # receiptHash /\ receiptHash # "none"
      [] lastResult = "stale" ->
         \/ lastRefGeneration # generation
         \/ receiptHash = "none"
         \/ lastRefFence # receiptFence
      [] OTHER -> FALSE
=============================================================================
