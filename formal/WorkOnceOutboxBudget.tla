------------------------- MODULE WorkOnceOutboxBudget -------------------------
EXTENDS Naturals, Sequences, FiniteSets
VARIABLES aQueue, bQueue, cQueue, cursor, calls, delivered
vars == <<aQueue, bQueue, cQueue, cursor, calls, delivered>>

Original == {"a1", "a2", "a3", "b1", "b2", "c1"}
SeqSet(q) == {q[i] : i \in 1..Len(q)}
Pending == SeqSet(aQueue) \cup SeqSet(bQueue) \cup SeqSet(cQueue)

Init ==
  /\ aQueue = <<"a1", "a2", "a3">>
  /\ bQueue = <<"b1", "b2">>
  /\ cQueue = <<"c1">>
  /\ cursor = "none"
  /\ calls = 0
  /\ delivered = {}

\* dispatch({limit: 2}) queries at most two parents and attempts at most two
\* children. The first call exhausts its attempt budget mid-parent A.
DispatchFirst ==
  /\ calls = 0
  /\ aQueue = <<"a1", "a2", "a3">>
  /\ aQueue' = <<"a3">>
  /\ cursor' = "A"
  /\ calls' = 1
  /\ delivered' = delivered \cup {"a1", "a2"}
  /\ UNCHANGED <<bQueue, cQueue>>

\* The exclusive cursor moves to parent B only after the next bounded page.
DispatchSecond ==
  /\ calls = 1
  /\ bQueue = <<"b1", "b2">>
  /\ bQueue' = <<>>
  /\ cursor' = "B"
  /\ calls' = 2
  /\ delivered' = delivered \cup {"b1", "b2"}
  /\ UNCHANGED <<aQueue, cQueue>>

\* Only one attempt remains on the final page; dispatch returns without an
\* eager wrap because the page itself was non-empty.
DispatchThird ==
  /\ calls = 2
  /\ cQueue = <<"c1">>
  /\ cQueue' = <<>>
  /\ cursor' = "C"
  /\ calls' = 3
  /\ delivered' = delivered \cup {"c1"}
  /\ UNCHANGED <<aQueue, bQueue>>

\* The next invocation sees an empty page after C, resets the cursor, and
\* reaches the partially drained A parent again.
DispatchFourth ==
  /\ calls = 3
  /\ aQueue = <<"a3">>
  /\ aQueue' = <<>>
  /\ cursor' = "A"
  /\ calls' = 4
  /\ delivered' = delivered \cup {"a3"}
  /\ UNCHANGED <<bQueue, cQueue>>

OutboxBudgetDispatch == DispatchFirst \/ DispatchSecond \/ DispatchThird \/ DispatchFourth
Next == OutboxBudgetDispatch
Spec == Init /\ [][Next]_vars

BudgetTypeOK ==
  /\ aQueue \in Seq({"a1", "a2", "a3"})
  /\ bQueue \in Seq({"b1", "b2"})
  /\ cQueue \in Seq({"c1"})
  /\ cursor \in {"none", "A", "B", "C"}
  /\ calls \in 0..4
  /\ delivered \subseteq Original

AllBudgetIntentAccounted ==
  /\ Original = Pending \cup delivered
  /\ Pending \cap delivered = {}

ExactBudgetPrefixes ==
  /\ (calls = 1 => delivered = {"a1", "a2"} /\ aQueue = <<"a3">> /\ cursor = "A")
  /\ (calls = 2 => delivered = {"a1", "a2", "b1", "b2"} /\ cursor = "B")
  /\ (calls = 3 => delivered = {"a1", "a2", "b1", "b2", "c1"} /\ aQueue = <<"a3">> /\ cursor = "C")
  /\ (calls = 4 => delivered = Original /\ Pending = {})

MidParentRemainsReachable == calls \in 1..3 => "a3" \in Pending
AllReachedByFourth == calls = 4 => delivered = Original
=============================================================================
