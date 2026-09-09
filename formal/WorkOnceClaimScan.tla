------------------------- MODULE WorkOnceClaimScan -------------------------
EXTENDS Naturals
CONSTANTS ScanWidth, ClaimLimit, InitialFront, InitialHealthy
ASSUME ScanWidth > 0
ASSUME InitialFront <= ScanWidth
ASSUME InitialHealthy > 0
ASSUME ClaimLimit > 0
VARIABLES pc, pass, frontRemaining, healthyRemaining, pageFront, pageHealthy,
          claimedThisPass, healthyClaimed, exhaustedTerminalized
vars == <<pc, pass, frontRemaining, healthyRemaining, pageFront, pageHealthy,
          claimedThisPass, healthyClaimed, exhaustedTerminalized>>

Min2(a, b) == IF a <= b THEN a ELSE b

Init ==
  /\ pc = "query"
  /\ pass = 0
  /\ frontRemaining = InitialFront
  /\ healthyRemaining = InitialHealthy
  /\ pageFront = 0 /\ pageHealthy = 0
  /\ claimedThisPass = 0 /\ healthyClaimed = 0 /\ exhaustedTerminalized = 0

Query ==
  /\ pc = "query" /\ pass < 2
  /\ pc' = "scan"
  /\ claimedThisPass' = 0
  /\ IF frontRemaining > 0
       THEN /\ pageFront' = Min2(frontRemaining, ScanWidth)
            /\ pageHealthy' = 0
       ELSE /\ pageFront' = 0
            /\ pageHealthy' = Min2(healthyRemaining, ScanWidth)
  /\ UNCHANGED <<pass, frontRemaining, healthyRemaining, healthyClaimed, exhaustedTerminalized>>

TerminalizeFront ==
  /\ pc = "scan" /\ pageFront > 0
  /\ pageFront' = pageFront - 1 /\ frontRemaining' = frontRemaining - 1
  /\ exhaustedTerminalized' = exhaustedTerminalized + 1
  /\ UNCHANGED <<pc, pass, healthyRemaining, pageHealthy, claimedThisPass, healthyClaimed>>

ClaimHealthy ==
  /\ pc = "scan" /\ pageFront = 0 /\ pageHealthy > 0
  /\ claimedThisPass < ClaimLimit
  /\ pageHealthy' = pageHealthy - 1 /\ healthyRemaining' = healthyRemaining - 1
  /\ claimedThisPass' = claimedThisPass + 1 /\ healthyClaimed' = healthyClaimed + 1
  /\ UNCHANGED <<pc, pass, frontRemaining, pageFront, exhaustedTerminalized>>

EndPass ==
  /\ pc = "scan" /\ pageFront = 0 /\ pass < 2
  /\ (pageHealthy = 0 \/ claimedThisPass = ClaimLimit)
  /\ pc' = "query" /\ pass' = pass + 1
  /\ pageFront' = 0 /\ pageHealthy' = 0 /\ claimedThisPass' = 0
  /\ UNCHANGED <<frontRemaining, healthyRemaining, healthyClaimed, exhaustedTerminalized>>

Next == Query \/ TerminalizeFront \/ ClaimHealthy \/ EndPass
Spec == Init /\ [][Next]_vars

ClaimScanTypeOK ==
  /\ pc \in {"query", "scan"}
  /\ pass \in 0..2
  /\ frontRemaining \in 0..InitialFront
  /\ healthyRemaining \in 0..InitialHealthy
  /\ pageFront \in 0..ScanWidth /\ pageHealthy \in 0..ScanWidth
  /\ claimedThisPass \in 0..ClaimLimit
  /\ healthyClaimed \in 0..InitialHealthy
  /\ exhaustedTerminalized \in 0..InitialFront

ClaimLimitHonored == claimedThisPass <= ClaimLimit
NoHealthyLoss == healthyRemaining + healthyClaimed = InitialHealthy
NoExhaustedLoss == frontRemaining + exhaustedTerminalized = InitialFront
FirstBoundedPassOnlyTerminalizesFront ==
  pass >= 1 => frontRemaining = 0
SecondInvocationReachesHealthy ==
  pass >= 2 => healthyClaimed > 0
=============================================================================
