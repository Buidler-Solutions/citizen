# Citizen Protocol (CITIZEN)

## Version
v0.1 – Draft Specification

## Status
Working Draft – Non-Currency, Governance-First Ledger

---


## Strategic Update
v0.2 – Deep Research Alignment (Authoritative for current implementation planning)

The repository is now aligned to the deep-research baseline in:
- `docs/DEEP_RESEARCH_ARCHITECTURE_BASELINE.md`

### Monorepo Documentation Boundary (Mandatory)

The root-level `docs/` directory is reserved exclusively for the `citizen-protocol/` project documentation.

- Treat `/docs` as the published documentation surface for `citizen-protocol/` only.
- Do **not** place `landing-page/` or `whitepaper/` documentation into root `/docs`.
- Documentation for `landing-page/` and `whitepaper/` must remain inside their own subfolders.
- Any future GitHub Pages or doc-link updates must preserve this boundary.

All contributors and agents should treat the following as active direction:

1. **Two-Plane Architecture**
   - Governed Data Plane (namespace-first) is the default build path.
   - Programmable Execution Plane (Rust/WASM) is optional, scoped, audited, and governance-gated.

2. **Builder-First Product Surface**
   - Prioritize canonical APIs, deterministic receipts, SDK usability, and local-stack onboarding.
   - Keep namespaces first-class even as execution capabilities expand.

3. **User Data Ownership**
   - On-chain: commitments, consent receipts, status/revocation events, governance proofs.
   - Off-chain: encrypted user-controlled data custody by default.

4. **Interoperability Rollout**
   - Standards-led and staged (identifier standards first, adapters/bridges later).
   - No ad-hoc one-off interoperability paths without governance review.

5. **Non-Speculative Economics**
   - Favor non-transferable builder fee credits and sponsored user actions.
   - Avoid introducing speculative token narratives into core protocol docs.

6. **Documentation Consistency Rule**
   - If documentation conflicts with the deep-research baseline, update or remove it.
   - Keep README and architecture docs synchronized with the baseline.

---

## 1. Abstract

This document specifies the **Decentralized Public Ledger Protocol (CITIZEN)** — a fast, Sybil-resistant, governance-driven distributed ledger designed for **public truth, records, and accountability**, not cryptocurrency speculation.

The protocol achieves **deterministic finality** using a **Byzantine Fault Tolerant (BFT) consensus** that requires **≥80% validator agreement** per block, providing strong resistance against Sybil attacks, collusion, and history rewrites.

---

## 2. Design Goals

### 2.1 Primary Goals
- Decentralized public ledger (append-only truth)
- Non-currency-centric by design
- Strong Sybil resistance
- Deterministic finality (no forks, no reorgs)
- Fast block generation (≈1 second)
- Governance-driven evolution

### 2.2 Explicit Non-Goals
- Price speculation
- Proof-of-Work mining
- Anonymous validator participation
- Probabilistic confirmations
- High-frequency financial trading

---

## 3. Core Definitions

### Ledger
An **append-only, cryptographically verifiable record of events** shared across independent validators.

### Validator
A governance-approved entity responsible for:
- Proposing blocks
- Voting in consensus
- Participating in governance

Validators are **identity-anchored and non-anonymous**.

### Namespace
A logical domain defining the rules for ledger entries (e.g.:w, land registry, identity, audit).

---

## 4. Threat Model

The protocol explicitly defends against:
- Sybil attacks
- Byzantine validators (≤19%)
- Network partitions
- Malicious block proposers
- Replay attacks

The protocol assumes:
- Validator identities are scarce and verifiable
- Network latency is bounded (global but reasonable)

---
## 5. Sybil Resistance Model

### 5.1 Validator Admission

- Validators are **not permissionless**
- Admission requires **≥80% approval** from existing validators
- All admissions are recorded on-chain

### 5.2 Identity Anchors
Each validator must present at least one:
- Institutional identity (e.g., NGO, university, court)
- Legal entity
- Hardware-backed cryptographic key (TPM/HSM)
- Governance bond (non-speculative)

This structure makes large-scale identity forgery infeasible.

---

## 6. Consensus Protocol

### 6.1 Overview

CITIZEN uses a **linear, leader-based BFT consensus** inspired by HotStuff, modified to require **≥80% quorum**.

- No forks
- Immediate finality
- Deterministic block commitment

### 6.2 Parameters

- N = total active validators
- QUORUM = ceil(0.8 × N)
- Block time target = **1 second**

---

### 6.3 Consensus Phases

#### Phase 1 — Propose
- A deterministic leader proposes a block

#### Phase 2 — Pre-Vote
- Validators verify the block
- Validators broadcast signed pre-votes

If pre-votes ≥ QUORUM → proceed

#### Phase 3 — Commit
- Validators aggregate signatures (threshold BLS)
- Block is finalized and immutable

If quorum not reached within timeout:
- Round aborts
- Leader rotates
- No state change

---

## 7. Block Structure

```json
{
  "height": 1024,
  "prev_hash": "...",
  "entry_root": "merkle_root",
  "proposer": "validator_id",
  "timestamp": 1736500000,
  "commit_proof": "BLS_AGG_SIGNATURE"
}
```

---

## 8. Ledger Entry Model

Ledger entries represent **events**, not payments.

```json
{
  "entry_id": "uuid",
  "namespace": "registry.land",
  "action": "TRANSFER",
  "object_id": "LOT-239-A",
  "payload": { "from": "did:A", "to": "did:B" },
  "author": "did:A",
  "signature": "sig",
  "timestamp": 1736500000
}
```

---

## 9. Namespaces & Rules

Namespaces prevent abuse and enforce domain-specific logic.

Examples:
- identity.citizen
- registry.land
- audit.procurement
- governance.vote
- supplychain.batch

Each namespace defines:
- Who may write
- Validation rules
- Required proofs

---

## 10. Cryptography

- Hashing: SHA-256 / BLAKE3
- Signatures: BLS threshold signatures
- Merkle trees for entry integrity
- All messages are signed and replay-protected

---

## 11. Networking Layer

- Peer-to-peer gossip
- Authenticated peers only
- Signed consensus messages

Message types:
- PROPOSE
- PRE_VOTE
- COMMIT
- GOVERNANCE_VOTE

---

## 12. Governance Engine

### 12.1 Governance Actions
- Add / remove validator
- Update protocol parameters
- Emergency pause / resume

### 12.2 Voting Rules
- Validators only
- ≥80% approval
- Time-bounded voting
- Automatic on-chain execution

All governance activity is:
- Public
- Signed
- Auditable

---

## 13. Performance Characteristics

- Block time: ~1 second
- Finality: single block
- Validator count: 20–100 optimal
- Throughput limited by governance safety, not speculation

---

## 14. Security Guarantees

The protocol guarantees:
- Strong Sybil resistance
- Deterministic finality
- Tamper-evident history
- Governance-controlled evolution
- Public verifiability

---

## 15. Conclusion

CITIZEN defines a **next-generation decentralized public ledger** where trust is derived from **cryptography, governance, and institutional accountability**, not financial incentives.

It is suitable for:
- Public registries
- Governance systems
- Audit trails
- Civic infrastructure

Currency, if introduced, is merely an application namespace — **never the foundation**.

---

## 16. Rust Node Architecture

This section expands the protocol specification into a **concrete, working Rust node architecture**. The design is modular, production-oriented, and aligned with safety, performance, and auditability requirements.

---

## 16.1 High-Level Node Overview

Each node runs the same binary and may operate in one of two modes:
- **Validator node** (participates in consensus and governance)
- **Observer node** (read-only, full verification)

```text
┌───────────────────────────┐
│        Node Binary        │
├───────────────────────────┤
│ Networking (P2P / Gossip) │
│ Consensus Engine (BFT)    │
│ Ledger & State Engine     │
│ Governance Engine         │
│ Cryptography Layer        │
│ Storage Layer             │
│ API / RPC Interface       │
└───────────────────────────┘
```

---

## 16.2 Crate & Module Layout

Recommended Rust workspace layout:

```text
citizen-node/
├── Cargo.toml
├── node/               # binary crate
│   └── main.rs
├── consensus/          # BFT consensus engine
├── ledger/             # blocks, entries, namespaces
├── governance/         # proposals & voting
├── crypto/             # signatures, hashing
├── network/            # P2P, gossip, message handling
├── storage/            # RocksDB, Merkle trees
├── types/              # shared structs & enums
└── api/                # RPC / HTTP interface
```

Each module is **strictly separated** to allow auditing and formal reasoning.

---

## 16.3 Node Lifecycle

### Startup Sequence
1. Load configuration
2. Initialize cryptography & validator keys
3. Open persistent storage
4. Connect to known peers
5. Sync latest finalized block
6. Enter consensus loop

---

## 16.4 Networking Module (`network`)

Responsibilities:
- Peer discovery (static bootstrap + gossip)
- Authenticated connections only
- Message serialization & validation

Core message types:
- `BlockProposal`
- `PreVote`
- `Commit`
- `GovernanceVote`

All messages:
- Signed
- Timestamped
- Replay-protected

---

## 16.5 Consensus Engine (`consensus`)

Implements **leader-based linear BFT with ≥80% quorum**.

Key components:
- Proposer selection (deterministic rotation)
- Round timers (1s hard cap)
- Vote collection & quorum checks
- Threshold signature aggregation

Consensus loop (simplified):
```text
Propose → PreVote → Commit → Finalize
```

No forks. No rollback logic.

---

## 16.6 Ledger Engine (`ledger`)

Responsibilities:
- Block validation
- Merkle root computation
- Namespace rule enforcement
- State transition application

Ledger is **event-sourced**:
- History = immutable
- State = derived

---

## 16.7 Governance Engine (`governance`)

Responsibilities:
- Proposal lifecycle management
- Validator admission & removal
- Parameter updates

Governance rules:
- Validators only
- ≥80% approval
- Time-bounded voting
- Automatic execution

---

## 16.8 Cryptography Layer (`crypto`)

Responsibilities:
- BLS threshold signatures
- Individual validator signatures
- Hashing (SHA-256 / BLAKE3)

This layer has **no business logic**.

---

## 16.9 Storage Layer (`storage`)

Responsibilities:
- Block persistence
- Ledger entry storage
- Merkle tree management
- Fast state queries

Recommended backend:
- RocksDB

---

## 16.10 API / RPC (`api`)

Exposes read-only and control endpoints:
- Query blocks & entries
- Submit ledger entries
- Submit governance proposals

Observer nodes expose **read-only APIs**.

---

## 16.11 Node Roles

### Validator Node
- Runs full consensus
- Signs votes
- Participates in governance

### Observer Node
- No voting power
- Verifies all blocks
- Serves public queries

---

## 16.12 Safety & Performance Notes

- No dynamic memory in consensus hot path
- No blocking I/O in voting
- Strict message validation
- Deterministic execution

---

## 16.13 Implementation Status

This architecture is sufficient to implement:
- A minimal working network
- Multi-node BFT consensus
- Governance-controlled validator set

It intentionally avoids:
- Speculation logic
- Token economics
- Permissionless validator churn

---

## 17. Validator Onboarding & Governance Flow

This section defines the **validator lifecycle**, including **admission, operation, removal, and emergency governance powers**. These rules are mandatory and form part of the protocol’s security model.

---

## 17.1 Validator Lifecycle Overview

```text
Candidate → Admitted Validator → Active Validator
                    ↓
              Suspended / Removed
```

Validators are **scarce, identity-anchored participants**. There is no automatic or permissionless entry.

---

## 17.2 Validator Admission (Onboarding)

### 17.2.1 Eligibility Requirements

A validator candidate MUST provide:
- A long-term cryptographic public key
- A verifiable identity anchor (at least one):
  - Institution (NGO, university, court, auditor)
  - Registered legal entity
  - Hardware-backed key (TPM / HSM)
  - Governance bond or reputational stake

All submitted materials are hashed and recorded on-chain.

---

### 17.2.2 Admission Proposal

Validator admission is initiated via a **governance proposal**:

```json
{
  "proposal_type": "ADD_VALIDATOR",
  "candidate_id": "did:ledger:validator:xyz",
  "pubkey": "...",
  "anchors": ["University of X"],
  "voting_period": "14 days"
}
```

---

### 17.2.3 Voting Rules

- Only **active validators** may vote
- Approval requires **≥80% of all active validators**
- Votes are:
  - Signed
  - Public
  - Irrevocable

If quorum is not reached → proposal fails automatically.

---

### 17.2.4 Activation

Upon approval:
- Validator is added to the active set
- Validator becomes eligible for proposer rotation
- Effective from the **next block height**

No retroactive effects.

---

## 17.3 Validator Responsibilities

Active validators MUST:
- Maintain high availability
- Participate honestly in consensus
- Vote in governance when required
- Protect private keys

Failure to meet responsibilities may trigger suspension or removal.

---

## 17.4 Validator Suspension

### 17.4.1 Grounds for Suspension

A validator may be **temporarily suspended** for:
- Extended downtime
- Network misbehavior
- Failure to participate in consensus

Suspension proposal:
- Requires ≥80% approval
- May specify duration

Suspended validators:
- Do NOT count toward quorum
- Do NOT propose or vote

---

## 17.5 Validator Removal (Ejection)

### 17.5.1 Grounds for Removal

Permanent removal may occur if a validator:
- Acts maliciously (double-signing, invalid proposals)
- Colludes to censor the ledger
- Loses legal or institutional standing
- Repeatedly violates governance rules

---

### 17.5.2 Removal Proposal

```json
{
  "proposal_type": "REMOVE_VALIDATOR",
  "validator_id": "did:ledger:validator:abc",
  "reason": "Byzantine behavior",
  "evidence_hash": "..."
}
```

Approval requires **≥80% of active validators**.

Removal effects:
- Immediate upon execution
- Validator keys blacklisted
- Historical blocks remain valid

---

## 17.6 Emergency Governance Powers

### 17.6.1 Emergency Conditions

Emergency powers may be invoked if:
- Consensus is stalled (quorum unreachable)
- Coordinated attack is detected
- Catastrophic software fault occurs

---

### 17.6.2 Emergency Actions

Permitted emergency actions:
- Temporarily pause block production
- Temporarily adjust quorum (must be explicit)
- Suspend specific validators
- Trigger mandatory software upgrade

All emergency actions:
- Require ≥80% approval
- Are time-limited
- Are fully recorded on-chain

---

## 17.7 Governance Safety Guarantees

The governance system guarantees:
- No unilateral control
- No silent validator changes
- No hidden authority
- Full public auditability

Governance is part of consensus security, not an external process.

---

## 17.8 Summary

Validator onboarding and governance form the **primary Sybil-resistance layer** of the protocol. By requiring **identity anchoring, supermajority approval, and public accountability**, the ledger remains decentralized without becoming vulnerable to identity forgery or capture.

---

## 18. Ledger Namespaces & Rule Enforcement

This section defines **ledger namespaces** — the mechanism that allows the protocol to support **multiple public-ledger use cases** (land, identity, audit, governance) without becoming currency-centric or logic-fragmented.

Namespaces provide **domain isolation, rule enforcement, and security boundaries**.

---

## 18.1 Namespace Concept

A **namespace** is a logical domain that:
- Defines what entries are allowed
- Specifies who may author entries
- Enforces validation rules
- Prevents cross-domain abuse

Each ledger entry MUST belong to exactly one namespace.

```text
ledger entry → namespace → rule engine
```

---

## 18.2 Core Namespace Registry

Namespaces are registered and governed on-chain.

```json
{
  "namespace": "registry.land",
  "version": 1,
  "rules_hash": "...",
  "governed_by": "governance"
}
```

- Creating or modifying a namespace requires **≥80% governance approval**
- Namespace rules are immutable per version

---

## 18.3 Identity Namespace (`identity.citizen`)

### Purpose
Provides decentralized identity anchors without exposing personal data.

### Allowed Actions
- REGISTER_IDENTITY
- UPDATE_CLAIM
- REVOKE_IDENTITY

### Rules
- Identity entries MUST be signed by the subject
- Optional issuer attestation (e.g., authority, institution)
- Only hashes / commitments are stored on-chain

Example:
```json
{
  "namespace": "identity.citizen",
  "action": "REGISTER_IDENTITY",
  "subject": "did:ledger:abc",
  "claims_hash": "...",
  "signature": "sig"
}
```

---

## 18.4 Land Registry Namespace (`registry.land`)

### Purpose
Records ownership and transfer of land or physical assets.

### Allowed Actions
- REGISTER_PARCEL
- TRANSFER_OWNERSHIP
- ANNOTATE_DISPUTE

### Rules
- Transfers require:
  - Current owner signature
  - Validator verification
- Double-transfer is invalid
- Historical ownership is immutable

Example:
```json
{
  "namespace": "registry.land",
  "action": "TRANSFER_OWNERSHIP",
  "parcel_id": "LOT-239-A",
  "from": "did:A",
  "to": "did:B",
  "signature": "sig"
}
```

---

## 18.5 Audit Namespace (`audit.procurement`)

### Purpose
Creates immutable audit trails for public or private processes.

### Allowed Actions
- RECORD_EVENT
- LINK_DOCUMENT
- CLOSE_AUDIT

### Rules
- Entries are append-only
- Documents stored off-chain
- Ledger stores document hash + timestamp

Example:
```json
{
  "namespace": "audit.procurement",
  "action": "RECORD_EVENT",
  "event": "BID_OPENED",
  "document_hash": "...",
  "timestamp": 1736500000
}
```

---

## 18.6 Governance Namespace (`governance.vote`)

### Purpose
Handles protocol governance and validator decisions.

### Allowed Actions
- SUBMIT_PROPOSAL
- CAST_VOTE
- EXECUTE_PROPOSAL

### Rules
- Only validators may vote
- Votes are signed and public
- Approval threshold: ≥80%

Example:
```json
{
  "namespace": "governance.vote",
  "action": "CAST_VOTE",
  "proposal_id": "GOV-042",
  "vote": "YES",
  "validator": "did:validator:X",
  "signature": "sig"
}
```

---

## 18.7 Namespace Rule Engine

Each node enforces namespace rules during block validation:

Validation pipeline:
1. Verify signature
2. Check namespace existence
3. Apply namespace-specific rules
4. Reject invalid entries

Invalid entries cause the entire block to be rejected.

---

## 18.8 Safety & Isolation Guarantees

Namespaces guarantee:
- No cross-domain privilege escalation
- No currency leakage into core ledger
- Independent evolution of domains
- Strong auditability per domain

---

## 18.9 Summary

Ledger namespaces are the mechanism that allows the protocol to act as a **general-purpose decentralized public ledger** while preserving safety, clarity, and governance control.

They are essential to keeping the system **truth-centric rather than currency-centric**.

---

## 19. Stress Testing & Validator Simulation (50–100 Validators)

This section defines the **mandatory stress-testing and simulation framework** for validating safety, liveness, and performance of the protocol at realistic scale.

The objective is to prove that the ledger remains **fast, safe, and Sybil-resistant** under adverse conditions.

---

## 19.1 Simulation Objectives

The simulation framework MUST validate:
- Deterministic finality at ≥80% quorum
- Sub-second to ~1s block finality
- Correct behavior under validator failures
- Resistance to malicious behavior
- Governance survivability under stress

---

## 19.2 Validator Set Sizes

Mandatory test configurations:

- **50 validators** (baseline production minimum)
- **75 validators** (regional + institutional mix)
- **100 validators** (upper recommended bound)

Validator voting power is **equal-weighted**.

---

## 19.3 Network Latency Model

Simulated network characteristics:

- Same-region RTT: 20–50 ms
- Cross-region RTT: 80–180 ms
- Jitter: ±20 ms
- Packet loss: up to 1% (non-correlated)

All simulations assume authenticated, encrypted channels.

---

## 19.4 Test Scenario A — Normal Operation

### Conditions
- Validators online: 100%
- Honest behavior
- Stable network

### Expected Results
- Block finality: **600–900 ms**
- No aborted rounds
- No leader rotation penalties

---

## 19.5 Test Scenario B — Partial Validator Failure

### Conditions
- Validators online: 85%
- Random validator outages

### Expected Results
- Consensus remains live
- Block finality ≤ 1 second
- No safety violations

---

## 19.6 Test Scenario C — Quorum Loss

### Conditions
- Validators online: 75%
- Below quorum threshold

### Expected Results
- ❌ No block finalization
- ✔ No invalid blocks committed
- ✔ Consensus safely stalls

Governance intervention is required to restore liveness.

---

## 19.7 Test Scenario D — Malicious Leader

### Conditions
- Leader proposes invalid block

### Expected Results
- Pre-vote rejection
- Leader rotation
- Block height unchanged
- No delay > one round

---

## 19.8 Test Scenario E — Byzantine Validators

### Conditions
- Up to 19% validators Byzantine
- Double-signing, vote withholding, invalid messages

### Expected Results
- Safety preserved
- No fork or invalid state
- Governance evidence collected

---

## 19.9 Test Scenario F — Network Partition

### Conditions
- Validators split: 60% / 40%

### Expected Results
- ❌ No block finalization
- ✔ No divergence
- ✔ Automatic recovery after partition heals

---

## 19.10 Performance Metrics

The following metrics MUST be collected:

- Block finality latency (p50 / p95)
- Aborted round count
- Leader rotation frequency
- Message volume per block
- CPU & memory usage

---

## 19.11 Simulation Tooling

Recommended tooling:
- Deterministic simulation harness
- Configurable latency injection
- Fault injection (crash / Byzantine)
- Reproducible test seeds

Simulation code MUST be open and auditable.

---

## 19.12 Acceptance Criteria

The protocol is considered **production-viable** if:

- Safety holds in all scenarios
- Liveness holds at ≥80% validator availability
- Finality remains ≤1 second under normal conditions
- No fork or rollback occurs

---

## 19.13 Summary

Stress testing at 50–100 validators is a **mandatory gate** before real-world deployment. This process validates that the protocol’s security and performance claims are not theoretical but operationally sound.

---

*End of Specification*

