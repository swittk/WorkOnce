---------------------------- MODULE WorkOnceOutbox ----------------------------
EXTENDS Naturals, Sequences, FiniteSets, WorkOnceContract
CONSTANTS AllowCrash, MaxCrashes, MaxPasses
ASSUME MaxCrashes <= 1
VARIABLES aQueue, bQueue, cursor, attempts, delivered, passCount, crashes
vars == <<aQueue, bQueue, cursor, attempts, delivered, passCount, crashes>>

OriginalChildren == {"a1", "a2", "b1"}
HealthyChildren == {"a2", "b1"}
SeqSet(q) == {q[i] : i \in 1..Len(q)}
Pending == SeqSet(aQueue) \cup SeqSet(bQueue)
FirstOf(q) == q[1]
DropHead(q) == IF Len(q) <= 1 THEN <<>> ELSE SubSeq(q, 2, Len(q))
RotateHead(q) == IF Len(q) <= 1 THEN q ELSE Append(DropHead(q), FirstOf(q))

Init ==
  /\ aQueue = <<"a1", "a2">>
  /\ bQueue = <<"b1">>
  /\ cursor = "none"
  /\ attempts = <<>>
  /\ delivered = {}
  /\ passCount = 0
  /\ crashes = 0

\* Query order is A then B. afterId is exclusive. An empty page with a cursor
\* wraps to the beginning inside the same dispatch() call.
NextParent ==
  IF cursor = "none" THEN
    IF Len(aQueue) > 0 THEN "A" ELSE IF Len(bQueue) > 0 THEN "B" ELSE "none"
  ELSE IF cursor = "A" THEN
    IF Len(bQueue) > 0 THEN "B" ELSE IF Len(aQueue) > 0 THEN "A" ELSE "none"
  ELSE
    IF Len(aQueue) > 0 THEN "A" ELSE IF Len(bQueue) > 0 THEN "B" ELSE "none"

AttemptA ==
  /\ passCount < MaxPasses
  /\ NextParent = "A"
  /\ LET child == FirstOf(aQueue) IN
       /\ cursor' = "A"
       /\ attempts' = Append(attempts, child)
       /\ passCount' = passCount + 1
       /\ IF child = "a1"
            THEN /\ aQueue' = RotateHead(aQueue) /\ UNCHANGED delivered
            ELSE /\ aQueue' = DropHead(aQueue) /\ delivered' = delivered \cup {child}
  /\ UNCHANGED <<bQueue, crashes>>

AttemptB ==
  /\ passCount < MaxPasses
  /\ NextParent = "B"
  /\ LET child == FirstOf(bQueue) IN
       /\ cursor' = "B"
       /\ attempts' = Append(attempts, child)
       /\ passCount' = passCount + 1
       /\ bQueue' = DropHead(bQueue)
       /\ delivered' = delivered \cup {child}
  /\ UNCHANGED <<aQueue, crashes>>

\* This finite poison-retention lane never reaches an all-queues-drained page:
\* a1 remains durable by construction. The production empty-page cursor reset is
\* represented by the bounded-page wrap in WorkOnceOutboxBudget and executable
\* outbox refinement rather than by an unreachable transition in this module.

\* A fresh createWorkOnce() process loses only the in-memory cursor. Durable
\* parent queues and delivered children are unchanged.
CrashRestart ==
  /\ AllowCrash
  /\ crashes < MaxCrashes
  /\ cursor # "none"
  /\ cursor' = "none"
  /\ crashes' = crashes + 1
  /\ UNCHANGED <<aQueue, bQueue, attempts, delivered, passCount>>

OutboxDispatch == AttemptA \/ AttemptB
Next == OutboxDispatch \/ CrashRestart
Spec == Init /\ [][Next]_vars

OutboxTypeOK ==
  /\ aQueue \in Seq({"a1", "a2"})
  /\ bQueue \in Seq({"b1"})
  /\ cursor \in {"none", "A", "B"}
  /\ attempts \in Seq(OriginalChildren)
  /\ delivered \subseteq HealthyChildren
  /\ passCount \in 0..MaxPasses
  /\ crashes \in 0..MaxCrashes

\* Every original durable intent is either still queued or successfully delivered.
\* A restart or cursor movement may never erase one.
AllOriginalIntentAccounted ==
  /\ OriginalChildren = Pending \cup delivered
  /\ Pending \cap delivered = {}

\* a1 is the deliberately permanent conflicting child. It may be retried and
\* rotated but it is never falsely acknowledged or lost.
PoisonIntentRetained == "a1" \in Pending /\ "a1" \notin delivered

\* With limit=1, advancing the cursor before attempting the first parent is
\* intentional cross-parent fairness: a1 (fails), b1, then wrapped a2.
FirstPassRotatesPoison ==
  crashes = 0 /\ passCount = 1 =>
    /\ attempts = <<"a1">>
    /\ aQueue = <<"a2", "a1">>
    /\ cursor = "A"
CrossParentOrder ==
  crashes = 0 /\ Len(attempts) >= 3 =>
    SubSeq(attempts, 1, 3) = <<"a1", "b1", "a2">>

\* Even with one process restart between calls, three bounded dispatch calls are
\* enough to attempt/deliver both healthy children in this finite two-parent lane.
HealthyReachedByThirdPass == passCount >= 3 => HealthyChildren \subseteq delivered
=============================================================================
