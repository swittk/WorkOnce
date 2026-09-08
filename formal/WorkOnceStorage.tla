--------------------------- MODULE WorkOnceStorage ---------------------------
EXTENDS Naturals, FiniteSets
CONSTANT Samples, MaxConflicts
VARIABLES pc, nativeRevision, observedRevision, compareMisses, callerCommits, unknownCommitted, deadlineReached, deadlineExpired
vars == <<pc, nativeRevision, observedRevision, compareMisses, callerCommits, unknownCommitted, deadlineReached, deadlineExpired>>

Init ==
  /\ pc = "ready"
  /\ nativeRevision = 0
  /\ observedRevision = 0
  /\ compareMisses = 0
  /\ callerCommits = 0
  /\ unknownCommitted = FALSE
  /\ deadlineReached = FALSE
  /\ deadlineExpired = FALSE

Read ==
  /\ pc \in {"ready", "retry"}
  /\ pc' = "decide"
  /\ observedRevision' = nativeRevision
  /\ UNCHANGED <<nativeRevision, compareMisses, callerCommits, unknownCommitted, deadlineReached, deadlineExpired>>

ExternalWrite ==
  /\ pc = "decide"
  /\ nativeRevision < MaxConflicts + 1
  /\ nativeRevision' = nativeRevision + 1
  /\ UNCHANGED <<pc, observedRevision, compareMisses, callerCommits, unknownCommitted, deadlineReached, deadlineExpired>>

CompareMiss ==
  /\ pc = "decide"
  /\ observedRevision # nativeRevision
  /\ compareMisses < MaxConflicts
  /\ compareMisses' = compareMisses + 1
  /\ pc' = IF compareMisses' < MaxConflicts THEN "retry" ELSE "exhausted"
  /\ UNCHANGED <<nativeRevision, observedRevision, callerCommits, unknownCommitted, deadlineReached, deadlineExpired>>

CompareCommit ==
  /\ pc = "decide"
  /\ observedRevision = nativeRevision
  /\ callerCommits = 0
  /\ ~deadlineReached
  /\ nativeRevision' = nativeRevision + 1
  /\ callerCommits' = 1
  /\ pc' = "done"
  /\ UNCHANGED <<observedRevision, compareMisses, unknownCommitted, deadlineReached, deadlineExpired>>

UnknownCommit ==
  /\ pc = "decide"
  /\ observedRevision = nativeRevision
  /\ callerCommits = 0
  /\ ~deadlineReached
  /\ nativeRevision' = nativeRevision + 1
  /\ callerCommits' = 1
  /\ unknownCommitted' = TRUE
  /\ pc' = "unknown"
  /\ UNCHANGED <<observedRevision, compareMisses, deadlineReached, deadlineExpired>>

ExpireDeadline ==
  /\ pc = "decide"
  /\ ~deadlineReached
  /\ deadlineReached' = TRUE
  /\ UNCHANGED <<pc, nativeRevision, observedRevision, compareMisses, callerCommits, unknownCommitted, deadlineExpired>>

DeadlineReject ==
  /\ pc = "decide"
  /\ deadlineReached
  /\ observedRevision = nativeRevision
  /\ callerCommits = 0
  /\ pc' = "expired"
  /\ deadlineExpired' = TRUE
  /\ UNCHANGED <<nativeRevision, observedRevision, compareMisses, callerCommits, unknownCommitted, deadlineReached>>

DecisionFault ==
  /\ pc = "decide"
  /\ pc' = "decision_fault"
  /\ UNCHANGED <<nativeRevision, observedRevision, compareMisses, callerCommits, unknownCommitted, deadlineReached, deadlineExpired>>

Next == Read \/ ExternalWrite \/ CompareMiss \/ CompareCommit \/ UnknownCommit \/ ExpireDeadline \/ DeadlineReject \/ DecisionFault
Spec == Init /\ [][Next]_vars

StorageTypeOK ==
  /\ pc \in {"ready", "decide", "retry", "exhausted", "done", "unknown", "expired", "decision_fault"}
  /\ nativeRevision \in 0..(MaxConflicts + 2)
  /\ observedRevision \in 0..(MaxConflicts + 1)
  /\ compareMisses \in 0..MaxConflicts
  /\ callerCommits \in 0..1
  /\ unknownCommitted \in BOOLEAN
  /\ deadlineReached \in BOOLEAN
  /\ deadlineExpired \in BOOLEAN
AtMostOneCallerCommit == callerCommits <= 1
MissCannotCommit == pc \in {"retry", "exhausted"} => callerCommits = 0
DecisionFaultCannotCommit == pc = "decision_fault" => callerCommits = 0
UnknownOutcomeStopsRetry == pc = "unknown" => callerCommits = 1 /\ unknownCommitted
DeadlineExpiryStopsRetry == pc = "expired" => callerCommits = 0 /\ deadlineReached /\ deadlineExpired
ReachedDeadlineCannotCommit == deadlineReached => callerCommits = 0
FreshReadBeforeCommit == pc = "done" => observedRevision + 1 = nativeRevision
BoundedCompareMisses == compareMisses <= MaxConflicts

StorageSampleOK(s) ==
  CASE s.kind = "detached" ->
       /\ s.adapter \in {"memory", "sqlite", "cas"}
       /\ s.getManyDetached /\ s.queryDetached /\ s.orderExact /\ s.cursorExact
    [] s.kind = "atomicContention" ->
       /\ s.adapter \in {"memory", "sqlite", "cas"}
       /\ s.allSameSnapshot /\ s.oneInsertRevision /\ s.oneStoredRow
    [] s.kind = "queryBoundary" ->
       /\ s.adapter \in {"memory", "sqlite", "cas"}
       /\ s.dueOrderExact /\ s.dueLimitExact /\ s.dueCursorExactError
       /\ s.allCursorContinuation /\ s.allPageBounded
    [] s.kind = "invalidWrite" ->
       /\ s.adapter \in {"memory", "sqlite", "cas"}
       /\ s.exactRevisionError /\ s.exactIdentityError /\ s.exactDeadlineError
       /\ s.serializationBeforeCommit /\ s.deadlineEqualityRejected /\ s.noWrite
    [] s.kind = "casContention" -> s.freshReadRetries /\ s.committedOnce
    [] s.kind = "casExhaustion" -> s.exactAttempts /\ s.exactError /\ s.noCallerWrite
    [] s.kind = "casUnknown" -> s.exactError /\ s.noBlindRetry /\ s.committedTruthPreserved
    [] s.kind = "casHistoryCongruence" ->
       /\ s.materiallyDifferentHistory /\ s.sameDurableProjection /\ s.sameFuture
    [] s.kind = "casBoundary" -> s.zeroRejectedBeforeRead /\ s.oneAccepted /\ s.maxSafeAccepted
    [] s.kind = "sqliteBoundary" ->
       /\ s.zeroAccepted /\ s.maxSafeAccepted /\ s.negativeExact /\ s.fractionExact
    [] s.kind = "sqliteBusy" ->
       /\ s.messageBusyRetried /\ s.nativeBusyCodeRetried /\ s.nativeLockedCodeRetried
    [] OTHER -> FALSE
StorageSamplesConform ==
  /\ Samples # {}
  /\ {s.kind : s \in Samples} = {
       "detached", "atomicContention", "queryBoundary", "invalidWrite",
       "casContention", "casExhaustion", "casUnknown", "casHistoryCongruence",
       "casBoundary", "sqliteBoundary", "sqliteBusy"
     }
  /\ \A s \in Samples : StorageSampleOK(s)
=============================================================================
