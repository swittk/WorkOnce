-------------------------- MODULE WorkOnceRetention --------------------------
EXTENDS Naturals, FiniteSets

CONSTANT MaxTime, Incarnations, Samples

Policies == {"forever", "zero", "finite"}
Phases == {"absent", "queued", "running", "waiting", "terminal"}
StaleOperations == {"heartbeat", "settlement", "manual", "claim", "outbox", "cas"}

VARIABLES present, phase, policy, incarnation, revision, terminalAt, outbox, now,
          created, deleted, usedIncarnations, candidateIncarnation, candidateRevision,
          staleIncarnation, staleRevision, rejected, staleWrites, wrongDeletes,
          lastDeletePhase, lastDeletePolicy, lastDeleteOutbox, lastDeleteNow,
          lastDeleteDeadline, lastDeletedIncarnation, pruneWins

vars == <<present, phase, policy, incarnation, revision, terminalAt, outbox, now,
          created, deleted, usedIncarnations, candidateIncarnation, candidateRevision,
          staleIncarnation, staleRevision, rejected, staleWrites, wrongDeletes,
          lastDeletePhase, lastDeletePolicy, lastDeleteOutbox, lastDeleteNow,
          lastDeleteDeadline, lastDeletedIncarnation, pruneWins>>

NoCandidate == "no-candidate"
NoIncarnation == "no-incarnation"

FinitePolicy(p) == p \in {"zero", "finite"}
DeadlineFor(p, at) == IF p = "zero" THEN at ELSE at + 1
Eligible(p, state, hasOutbox, at, clock) ==
  /\ FinitePolicy(p)
  /\ state = "terminal"
  /\ ~hasOutbox
  /\ clock >= DeadlineFor(p, at)

Init ==
  /\ present = FALSE
  /\ phase = "absent"
  /\ policy = "none"
  /\ incarnation = NoIncarnation
  /\ revision = 0
  /\ terminalAt = 0
  /\ outbox = FALSE
  /\ now = 0
  /\ created = 0
  /\ deleted = 0
  /\ usedIncarnations = {}
  /\ candidateIncarnation = NoCandidate
  /\ candidateRevision = 0
  /\ staleIncarnation = NoIncarnation
  /\ staleRevision = 0
  /\ rejected = {}
  /\ staleWrites = 0
  /\ wrongDeletes = 0
  /\ lastDeletePhase = "none"
  /\ lastDeletePolicy = "none"
  /\ lastDeleteOutbox = FALSE
  /\ lastDeleteNow = 0
  /\ lastDeleteDeadline = 0
  /\ lastDeletedIncarnation = NoIncarnation
  /\ pruneWins = 0

CreateForever ==
  /\ ~present
  /\ created < 2
  /\ present' = TRUE
  /\ phase' = "queued"
  /\ policy' = "forever"
  /\ incarnation' = NoIncarnation
  /\ revision' = 1
  /\ terminalAt' = 0
  /\ outbox' = FALSE
  /\ created' = created + 1
  /\ UNCHANGED <<now, deleted, usedIncarnations, candidateIncarnation, candidateRevision,
                  staleIncarnation, staleRevision, rejected, staleWrites, wrongDeletes,
                  lastDeletePhase, lastDeletePolicy, lastDeleteOutbox, lastDeleteNow,
                  lastDeleteDeadline, lastDeletedIncarnation, pruneWins>>

CreateFinite ==
  /\ ~present
  /\ created < 2
  /\ \E p \in {"zero", "finite"}, fresh \in (Incarnations \ usedIncarnations):
       /\ present' = TRUE
       /\ phase' = "queued"
       /\ policy' = p
       /\ incarnation' = fresh
       /\ revision' = 1
       /\ terminalAt' = 0
       /\ outbox' = FALSE
       /\ created' = created + 1
       /\ usedIncarnations' = usedIncarnations \cup {fresh}
       /\ UNCHANGED <<now, deleted, candidateIncarnation, candidateRevision,
                       staleIncarnation, staleRevision, rejected, staleWrites, wrongDeletes,
                       lastDeletePhase, lastDeletePolicy, lastDeleteOutbox, lastDeleteNow,
                       lastDeleteDeadline, lastDeletedIncarnation, pruneWins>>

Create == CreateForever \/ CreateFinite

Claim ==
  /\ present
  /\ phase \in {"queued", "waiting"}
  /\ revision < 6
  /\ phase' = "running"
  /\ revision' = revision + 1
  /\ UNCHANGED <<present, policy, incarnation, terminalAt, outbox, now, created, deleted,
                  usedIncarnations, candidateIncarnation, candidateRevision,
                  staleIncarnation, staleRevision, rejected, staleWrites, wrongDeletes,
                  lastDeletePhase, lastDeletePolicy, lastDeleteOutbox, lastDeleteNow,
                  lastDeleteDeadline, lastDeletedIncarnation, pruneWins>>

Wait ==
  /\ present
  /\ phase = "running"
  /\ revision < 6
  /\ phase' = "waiting"
  /\ revision' = revision + 1
  /\ UNCHANGED <<present, policy, incarnation, terminalAt, outbox, now, created, deleted,
                  usedIncarnations, candidateIncarnation, candidateRevision,
                  staleIncarnation, staleRevision, rejected, staleWrites, wrongDeletes,
                  lastDeletePhase, lastDeletePolicy, lastDeleteOutbox, lastDeleteNow,
                  lastDeleteDeadline, lastDeletedIncarnation, pruneWins>>

Terminalize ==
  /\ present
  /\ phase \in {"queued", "running", "waiting"}
  /\ revision < 6
  /\ phase' = "terminal"
  /\ terminalAt' = now
  /\ revision' = revision + 1
  /\ outbox' \in BOOLEAN
  /\ UNCHANGED <<present, policy, incarnation, now, created, deleted, usedIncarnations,
                  candidateIncarnation, candidateRevision, staleIncarnation, staleRevision,
                  rejected, staleWrites, wrongDeletes, lastDeletePhase, lastDeletePolicy,
                  lastDeleteOutbox, lastDeleteNow, lastDeleteDeadline,
                  lastDeletedIncarnation, pruneWins>>

DrainOutbox ==
  /\ present
  /\ phase = "terminal"
  /\ outbox
  /\ revision < 6
  /\ outbox' = FALSE
  /\ revision' = revision + 1
  /\ UNCHANGED <<present, phase, policy, incarnation, terminalAt, now, created, deleted,
                  usedIncarnations, candidateIncarnation, candidateRevision,
                  staleIncarnation, staleRevision, rejected, staleWrites, wrongDeletes,
                  lastDeletePhase, lastDeletePolicy, lastDeleteOutbox, lastDeleteNow,
                  lastDeleteDeadline, lastDeletedIncarnation, pruneWins>>

ManualRestart ==
  /\ present
  /\ phase = "terminal"
  /\ ~outbox
  /\ revision < 6
  /\ phase' = "queued"
  /\ revision' = revision + 1
  /\ terminalAt' = 0
  /\ UNCHANGED <<present, policy, incarnation, outbox, now, created, deleted,
                  usedIncarnations, candidateIncarnation, candidateRevision,
                  staleIncarnation, staleRevision, rejected, staleWrites, wrongDeletes,
                  lastDeletePhase, lastDeletePolicy, lastDeleteOutbox, lastDeleteNow,
                  lastDeleteDeadline, lastDeletedIncarnation, pruneWins>>

Tick ==
  /\ now < MaxTime
  /\ now' = now + 1
  /\ UNCHANGED <<present, phase, policy, incarnation, revision, terminalAt, outbox,
                  created, deleted, usedIncarnations, candidateIncarnation,
                  candidateRevision, staleIncarnation, staleRevision, rejected,
                  staleWrites, wrongDeletes, lastDeletePhase, lastDeletePolicy,
                  lastDeleteOutbox, lastDeleteNow, lastDeleteDeadline,
                  lastDeletedIncarnation, pruneWins>>

Scan ==
  /\ present
  /\ candidateIncarnation' = incarnation
  /\ candidateRevision' = revision
  /\ UNCHANGED <<present, phase, policy, incarnation, revision, terminalAt, outbox,
                  now, created, deleted, usedIncarnations, staleIncarnation, staleRevision,
                  rejected, staleWrites, wrongDeletes, lastDeletePhase, lastDeletePolicy,
                  lastDeleteOutbox, lastDeleteNow, lastDeleteDeadline,
                  lastDeletedIncarnation, pruneWins>>

Prune ==
  /\ present
  /\ candidateIncarnation = incarnation
  /\ candidateRevision = revision
  /\ Eligible(policy, phase, outbox, terminalAt, now)
  /\ present' = FALSE
  /\ phase' = "absent"
  /\ policy' = "none"
  /\ incarnation' = NoIncarnation
  /\ revision' = 0
  /\ terminalAt' = 0
  /\ outbox' = FALSE
  /\ deleted' = deleted + 1
  /\ staleIncarnation' = candidateIncarnation
  /\ staleRevision' = candidateRevision
  /\ lastDeletePhase' = phase
  /\ lastDeletePolicy' = policy
  /\ lastDeleteOutbox' = outbox
  /\ lastDeleteNow' = now
  /\ lastDeleteDeadline' = DeadlineFor(policy, terminalAt)
  /\ lastDeletedIncarnation' = candidateIncarnation
  /\ pruneWins' = pruneWins + 1
  \* Derive the violation from the exact observed CAS identity, not a constant ghost flag.
  \* A faulty missing revision/incarnation comparison would delete a stale candidate's successor.
  /\ wrongDeletes' = wrongDeletes +
       (IF candidateIncarnation # incarnation \/ candidateRevision # revision THEN 1 ELSE 0)
  /\ UNCHANGED <<now, created, usedIncarnations, candidateIncarnation,
                  candidateRevision, rejected, staleWrites>>

LostPruneRace ==
  /\ candidateIncarnation # NoCandidate
  /\ \/ ~present
     \/ candidateIncarnation # incarnation
     \/ candidateRevision # revision
     \/ ~Eligible(policy, phase, outbox, terminalAt, now)
  /\ rejected' = {"prune"}
  /\ UNCHANGED <<present, phase, policy, incarnation, revision, terminalAt, outbox,
                  now, created, deleted, usedIncarnations, candidateIncarnation,
                  candidateRevision, staleIncarnation, staleRevision, staleWrites,
                  wrongDeletes, lastDeletePhase, lastDeletePolicy, lastDeleteOutbox,
                  lastDeleteNow, lastDeleteDeadline, lastDeletedIncarnation, pruneWins>>

\* Exercise an OLD saved worker/manual/outbox/CAS authority against the NEW row.
\* A real comparison decides whether it could write; mutation of that comparison must
\* produce a reachable stale-write counterexample, not an arbitrary counter jump.
TryOldAuthority(op) ==
  /\ op \in StaleOperations
  /\ present
  /\ staleIncarnation # NoIncarnation
  /\ LET accepted == staleIncarnation = incarnation IN
       /\ rejected' = IF accepted THEN {} ELSE {op}
       /\ staleWrites' = IF accepted THEN staleWrites + 1 ELSE staleWrites
  /\ UNCHANGED <<present, phase, policy, incarnation, revision, terminalAt, outbox,
                  now, created, deleted, usedIncarnations, candidateIncarnation,
                  candidateRevision, staleIncarnation, staleRevision,
                  wrongDeletes, lastDeletePhase, lastDeletePolicy, lastDeleteOutbox,
                  lastDeleteNow, lastDeleteDeadline, lastDeletedIncarnation, pruneWins>>

StaleOperation == \E op \in StaleOperations : TryOldAuthority(op)

Next == Create \/ Claim \/ Wait \/ Terminalize \/ DrainOutbox \/ ManualRestart \/
        Tick \/ Scan \/ Prune \/ LostPruneRace \/ StaleOperation
Spec == Init /\ [][Next]_vars

\* Safety alone never promises that a caller actually runs maintenance.
\* Under weak fairness of scheduled scans and deletes, work that is already
\* eligible cannot remain continuously present/eligible forever. This is a
\* conditional progress property, not a guarantee of periodic scheduling.
FairMaintenanceSpec == Spec /\ WF_vars(Scan) /\ WF_vars(Prune)
EligibleEventuallyClears ==
  (present /\ Eligible(policy, phase, outbox, terminalAt, now))
    ~> (~present \/ ~Eligible(policy, phase, outbox, terminalAt, now))

RetentionTypeOK ==
  /\ present \in BOOLEAN
  /\ phase \in Phases
  /\ policy \in Policies \cup {"none"}
  /\ incarnation \in Incarnations \cup {NoIncarnation}
  /\ revision \in 0..6
  /\ terminalAt \in 0..MaxTime
  /\ outbox \in BOOLEAN
  /\ now \in 0..MaxTime
  /\ created \in 0..2
  /\ deleted \in 0..2
  /\ usedIncarnations \subseteq Incarnations
  /\ candidateIncarnation \in Incarnations \cup {NoIncarnation, NoCandidate}
  /\ candidateRevision \in 0..6
  /\ staleIncarnation \in Incarnations \cup {NoIncarnation}
  /\ staleRevision \in 0..6
  /\ rejected \subseteq StaleOperations \cup {"prune"}
  /\ Cardinality(rejected) <= 1
  /\ staleWrites \in 0..1
  /\ wrongDeletes \in 0..1
  /\ lastDeletePhase \in Phases \cup {"none"}
  /\ lastDeletePolicy \in Policies \cup {"none"}
  /\ lastDeleteOutbox \in BOOLEAN
  /\ lastDeleteNow \in 0..MaxTime
  /\ lastDeleteDeadline \in 0..(MaxTime + 1)
  /\ lastDeletedIncarnation \in Incarnations \cup {NoIncarnation}
  /\ pruneWins \in 0..2

ActualDeletion == created = deleted + (IF present THEN 1 ELSE 0)
DeletionOnlyWhenEligible ==
  deleted > 0 =>
    /\ lastDeletePhase = "terminal"
    /\ FinitePolicy(lastDeletePolicy)
    /\ ~lastDeleteOutbox
    /\ lastDeleteNow >= lastDeleteDeadline
ForeverNeverDeleted == deleted > 0 => lastDeletePolicy # "forever"
FreshIncarnationAfterRecreate ==
  present /\ FinitePolicy(policy) /\ lastDeletedIncarnation # NoIncarnation =>
    incarnation # lastDeletedIncarnation
StaleAuthorityIsolated == staleWrites = 0
StaleCandidateCannotDeleteNew == wrongDeletes = 0
SinglePruneWinner == pruneWins = deleted
BoundedLiveRows == created - deleted <= 1

RetentionSampleOK(s) ==
  CASE s.kind = "boundary" ->
       /\ s.adapter \in {"memory", "sqlite"}
       /\ s.zeroDeletedAtEquality
       /\ s.finiteHeldBefore
       /\ s.finiteDeletedAtEquality
       /\ s.foreverRetained
    [] s.kind = "isolation" ->
       /\ s.adapter \in {"memory", "sqlite"}
       /\ s.freshIncarnation
       /\ s.matchingAttemptFence
       /\ s.staleHeartbeatRejected
       /\ s.staleSettlementRejected
       /\ s.freshRunningPreserved
       /\ s.activeRetained
       /\ s.outboxRetained
       /\ s.afterDrainDeleted
    [] s.kind = "race" ->
       /\ s.independentStores
       /\ s.singleWinner
       /\ s.physicallyAbsent
    [] s.kind = "replay" ->
       /\ s.deterministicDescription
       /\ s.descriptionHasNoIncarnation
       /\ s.receiptReplay
       /\ s.replayAfterExpiryIsFresh
    [] s.kind = "growth" ->
       /\ s.cycles = 16
       /\ s.rowsAfterCycles = 0
       /\ s.pageCountStable
    [] OTHER -> FALSE

AdapterSetFor(kind) ==
  {sample.adapter : sample \in {candidate \in Samples : candidate.kind = kind}}
RetentionSamplesConform ==
  /\ Samples # {}
  /\ {sample.kind : sample \in Samples} = {"boundary", "isolation", "race", "replay", "growth"}
  /\ AdapterSetFor("boundary") = {"memory", "sqlite"}
  /\ AdapterSetFor("isolation") = {"memory", "sqlite"}
  /\ \A sample \in Samples : RetentionSampleOK(sample)
=============================================================================
