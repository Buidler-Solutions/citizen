# Citizen Governance Charter v1.0

The Citizen Governance Charter defines validator duties, decision procedures, and emergency powers for the CITIZEN public ledger. Governance is inseparable from ledger security; all validators are bound by this charter as a condition of participation.

## 1. Validator Roles & Responsibilities

1. Validators are identity-anchored entities (institutions, public-interest organizations, or legally registered entities) approved by ≥80% supermajority.
2. Validators MUST:
   - Maintain ≥99% availability across rolling 30-day windows.
   - Participate honestly in consensus rounds and governance votes.
   - Secure signing keys in hardware-backed secure modules (HSM/TPM or equivalent).
   - Publish contact and accountability information visible to the community.
3. Validators MAY delegate infrastructure operations but remain responsible for misconduct or downtime caused by delegates.
4. Validators that fail to meet responsibilities are subject to suspension or removal under this charter.

## 2. Governance Proposals

1. Proposal types:
   - `ADD_VALIDATOR`
   - `REMOVE_VALIDATOR`
   - `SUSPEND_VALIDATOR`
   - `UPDATE_NAMESPACE_RULES`
   - `EMERGENCY_ACTION`
   - `PROTOCOL_PARAMETER_UPDATE`
2. Proposal process:
   - Submitted on-chain within the `governance.vote` namespace.
   - Includes author, payload, evidence references, and voting window (7–21 days typical).
   - Automatically queued and visible to every validator.
3. Quorum:
   - Decisions require participation from ≥80% of active validators.
   - Approval requires ≥80% `YES` votes of the full active set, not merely the quorum participants.
4. Votes are signed, immutable, and publicly discoverable.
5. Failure to reach quorum within the voting window invalidates the proposal; authors may resubmit with amended evidence or rationale.

## 3. Validator Admission & Removal

### Admission
1. Candidate submits identity anchors (institutional, legal, hardware, or governance bond) hashed and recorded on-chain.
2. Existing validators conduct due diligence and record findings in the proposal discussion log.
3. Admission is effective from the next finalized block once the supermajority threshold is met.

### Suspension
1. Grounds: sustained downtime (>48h), misconfigured networking, or failure to respond to incident reports.
2. Requires a time-bounded suspension proposal with remediation conditions.
3. Suspended validators lose proposer rotation and voting power but retain observation rights.

### Removal
1. Grounds: double-signing, censorship, collusion, legal dissolution, or repeated suspension violations.
2. Removal proposals must include evidence hashes and, when possible, off-chain reports.
3. Removal is immediate upon execution; keys are blacklisted and cannot rejoin without new admission.

## 4. Emergency Powers

1. Emergency actions require ≥80% approval and must be time-bounded (max 14 days) with explicit scope.
2. Permitted emergency actions:
   - Temporary pause of block production.
   - Temporary quorum adjustment with explicit end height/timestamp.
   - Immediate suspension of specified validators.
   - Mandatory protocol/software upgrade triggers.
3. Every emergency action includes a remediation roadmap and automatic expiry. Extensions require a brand-new vote.
4. Emergency logs are published under the `governance.vote` namespace with clear audit trails.

## 5. Transparency & Auditability

1. Governance dashboards display real-time proposal status, vote breakdowns, and validator participation metrics.
2. All validator keys and identity anchors are publicly queryable via the node API and archival endpoints.
3. Simulation reports for each release (≥50 validators) are published alongside binaries before deployment to testnet or mainnet.

## 6. Charter Amendment Process

1. Amendments follow the standard proposal flow with clear diffs and redlines.
2. Charter changes require 90% approval of active validators to ensure broad consensus.
3. Upon approval, the new charter version is recorded on-chain and supersedes prior versions at the designated activation height.

## 7. Enforcement & Compliance

1. Validators agree to be bound by this charter as part of the admission handshake.
2. Non-compliance triggers the enforcement ladder: warning → suspension → removal.
3. Governance maintains a public compliance log to track incidents, remediation steps, and their resolution status.

---

This charter is versioned and immutable once recorded on-chain. Future revisions must follow the amendment process above, ensuring that governance legitimacy grows alongside the network.
