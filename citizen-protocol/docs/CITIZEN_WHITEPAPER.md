# CITIZEN Whitepaper: A Mathematical Formulation of the Governance-First Ledger

## Abstract

This paper formalizes the consensus and governance logic of the CITIZEN protocol as a deterministic, identity-anchored Byzantine fault tolerant (BFT) system with a supermajority quorum threshold of 80%. We model validator admission, block finality, namespace rule enforcement, and governance transitions as state machines, then derive safety and liveness properties under explicit assumptions. We also evaluate whether this material belongs in a protocol whitepaper and provide a publication structure recommendation.

---

## 1. System Model

Let:

- \(V_h\) be the active validator set at height \(h\), with \(|V_h| = N_h\).
- Quorum threshold: \(Q_h = \lceil 0.8 N_h \rceil\).
- Byzantine bound: \(f_h\), with \(f_h \leq \lfloor 0.19 N_h \rfloor\).

Each validator \(v \in V_h\) has an identity anchor and one long-term public key. Consensus messages are signed, timestamped, and replay-protected.

### 1.1 Network assumptions

We assume partial synchrony:

1. There exists a Global Stabilization Time (GST).
2. After GST, message delay is bounded by \(\Delta\).
3. Authenticated channels prevent identity spoofing.

### 1.2 Deterministic chain model

A block at height \(h\) is:

\[
B_h = (h, H(B_{h-1}), R_h, p_h, t_h, \Pi_h)
\]

where:

- \(R_h\): Merkle root of entries,
- \(p_h\): proposer identity,
- \(t_h\): timestamp,
- \(\Pi_h\): aggregated commit proof over quorum signatures.

A block is final iff \(\Pi_h\) verifies against at least \(Q_h\) distinct active validators.

---

## 2. Consensus Algorithm (80%-BFT)

Consensus executes in rounds \(r\) at each height \(h\).

### 2.1 Phase rules

1. **Propose**: deterministic leader \(L_{h,r}\) proposes candidate block \(B_h^r\).
2. **Pre-Vote**: each validator verifies structural validity, namespace validity, and state transition validity.
3. **Commit**: if pre-votes \(\ge Q_h\), validators emit commit signatures; aggregated proof finalizes block.

If timeout occurs before quorum, the round aborts and leader rotates; state remains unchanged.

### 2.2 Canonical state transition

Let ledger state be \(S_h\). For accepted block \(B_h\):

\[
S_h = \Gamma(S_{h-1}, B_h)
\]

where \(\Gamma\) is deterministic. Therefore two honest validators applying the same finalized chain prefix derive identical \(S_h\).

---

## 3. Namespace Validation as Formal Constraints

Each entry \(e\) has namespace \(\nu(e)\). Let \(\mathcal{R}_\nu\) be namespace rules.

Block validity predicate:

\[
\text{Valid}(B_h, S_{h-1}) \iff \forall e \in B_h: \text{SigValid}(e) \land \text{NamespaceExists}(\nu(e)) \land \mathcal{R}_{\nu(e)}(e, S_{h-1})
\]

If any entry fails this predicate, honest validators reject the entire block.

This creates domain isolation and prohibits cross-namespace privilege escalation by construction.

---

## 4. Governance and Validator-Set Dynamics

Governance actions are ledger entries in namespace `governance.vote`.

For proposal \(P\), define validator vote function:

\[
\text{Yes}(P) = |\{ v \in V_h : v \text{ signs YES on } P \}|
\]

Execution condition:

\[
\text{Execute}(P) \iff \text{Yes}(P) \ge Q_h
\]

### 4.1 Admission rule

Candidate validator \(x\) becomes active at height \(h+1\) iff admission proposal satisfies execution condition at height \(h\). Hence:

\[
V_{h+1} = V_h \cup \{x\}
\]

only after explicit supermajority governance.

### 4.2 Removal rule

For approved removal proposal of validator \(y\):

\[
V_{h+1} = V_h \setminus \{y\}
\]

with immediate key blacklisting for future consensus messages.

---

## 5. Safety and Liveness Claims

## 5.1 Safety theorem (single-height uniqueness)

**Claim.** Two conflicting blocks at the same height cannot both finalize if at least 81% of validators are non-Byzantine.

**Sketch.** Any finalized block requires at least \(Q_h = \lceil 0.8N_h \rceil\) signatures. Assume conflicting finalized blocks \(B\) and \(B'\) at same height. Their signer sets \(C\) and \(C'\) each satisfy \(|C|, |C'| \ge 0.8N_h\). By pigeonhole/intersection bound:

\[
|C \cap C'| \ge |C| + |C'| - N_h \ge 0.6N_h
\]

At least 60% would have to sign conflicting commits. With \(\le 19\%\) Byzantine validators, at least 41% honest validators would equivocate, contradicting honest behavior assumptions. Therefore both cannot finalize.

## 5.2 Liveness claim

Under partial synchrony and with at least \(Q_h\) online honest validators, eventually a correct leader is scheduled and messages arrive within timeout bounds. Then quorum is reached and one block finalizes. Thus the protocol is live whenever online participation is at least 80% of active set.

## 5.3 Safe stalling property

If online validators fall below quorum (e.g., 75%), no block can gather valid commit proof. Therefore:

- no invalid progress is made,
- safety is preserved,
- governance recovery is required for liveness restoration.

---

## 6. Complexity and Operational Bounds

For \(N\) validators:

- Message complexity (naive gossip): \(O(N^2)\) per round.
- Signature verification load: \(O(N)\) pre-votes + one aggregated commit verification.
- Finality latency target: approximately one round (about 1 second target, network permitting).

For 50–100 validators, protocol performance is mainly constrained by network delay and signature aggregation overhead, not speculative transaction throughput.

---

## 7. Reference Pseudocode

```text
INPUT: active validators V, quorum Q=ceil(0.8*|V|), height h
STATE: round r = 0

while not finalized(h):
  leader = deterministic_leader(h, r)
  proposal = leader.propose_block(h)

  if verify_block(proposal) and verify_namespaces(proposal):
    broadcast(PRE_VOTE, sign(proposal.hash))

  if count_valid(PRE_VOTE, proposal.hash) >= Q:
    broadcast(COMMIT, sign(proposal.hash))

  if count_valid(COMMIT, proposal.hash) >= Q:
    proof = aggregate_signatures(COMMIT)
    finalize_block(h, proposal, proof)
    break

  r = r + 1
```

---

## 8. Whitepaper Appropriateness Assessment

Yes—**a whitepaper is appropriate and recommended** for CITIZEN.

### 8.1 Why a whitepaper fits this project

CITIZEN has properties that benefit from formal exposition:

1. Non-standard quorum design (80% vs typical 2/3 BFT thresholds).
2. Governance-coupled validator admission/removal as part of security.
3. Namespace-first ledger semantics (event truth over payments).
4. Deterministic finality claims requiring explicit assumptions and proofs.

A whitepaper is the right vehicle to present rationale, model assumptions, guarantees, and limitations in one canonical public document.

### 8.2 Suggested document split

Use three layered documents:

1. **Protocol Whitepaper (audience: architects, institutions, evaluators)**  
   - Motivation, threat model, formal model, theorem statements, governance/security rationale.
2. **Engineering Specification (audience: implementers)**  
   - Exact wire formats, state transition rules, APIs, test vectors, failure handling.
3. **Operational & Policy Runbooks (audience: operators and governance bodies)**  
   - Admission playbooks, incident response, upgrade governance, disaster recovery.

This keeps the whitepaper rigorous but stable, while allowing implementation docs to evolve faster.

### 8.3 Recommended title

> **CITIZEN: A Governance-First Deterministic Ledger with 80% BFT Finality and Namespace-Scoped Public Truth**

---

## 9. Conclusion

CITIZEN can be modeled as a deterministic, identity-anchored BFT state machine with governance-native validator control and namespace-scoped semantics. Under explicit assumptions, the protocol admits clear safety and liveness arguments and has a strong basis for formal publication. A whitepaper is not only appropriate; it is strategically important for auditability, institutional trust, and long-term protocol governance.
