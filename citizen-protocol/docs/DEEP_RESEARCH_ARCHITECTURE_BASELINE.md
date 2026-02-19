# Citizen Deep Research Architecture Baseline

## Context

This baseline incorporates the latest research direction for Citizen: build an interoperable, Rust-first, builder-oriented protocol while preserving Citizen's governance-first and non-speculative core.

Citizen remains a public-truth ledger first, not a token-speculation chain.

## Core Invariants (Must Not Change)

- Governance-first protocol evolution.
- Identity-anchored validator membership.
- Deterministic finality and safety-first consensus behavior.
- Namespace-based domain isolation and rule enforcement.
- Non-currency-centric positioning.

These are constitutional constraints for all future implementation phases.

## Target Product Model

Citizen should be delivered as two connected planes:

1. **Governed Data Plane (default path for builders)**
   - Namespaces define schema, permissions, and validation rules.
   - Best for civic records, registries, governance logs, and audit trails.

2. **Programmable Execution Plane (scoped and audited)**
   - Deterministic Rust/WASM runtime for approved module classes.
   - Focus areas: assets, interoperability adapters, identity/consent policies.
   - Governance-gated deployment and activation.

## Builder-First Direction

Citizen builder experience must prioritize:

- Namespace-first development path before smart contracts.
- Stable SDKs and canonical APIs across node, DApp backend, wallet, and explorer.
- Deterministic receipts (finality proof + validation outcome).
- Fast local stack onboarding and reproducible templates.

## User Data Ownership Direction

Citizen data model must default to:

- **On-chain**: commitments, consent receipts, revocation/status events, governance proofs.
- **Off-chain**: encrypted user data under user-controlled custody.

Protocol requirements:

- Signed, time-scoped consent events.
- Verifiable authorization history.
- Portable identity and claims via DID/VC-compatible flows.

## Interoperability Direction (Staged)

Interoperability must be standards-led and phased:

### Stage 1 — Identifier Standardization

- CAIP-style chain and account identifiers across APIs/SDKs/explorer.

### Stage 2 — Message and Adapter Surfaces

- Canonical cross-domain message envelopes.
- Governance-reviewed relayer/adapter policies.

### Stage 3 — Audited Bridge / Interop Modules

- High-assurance adapters for external ecosystems.
- Explicit governance controls, observability, and emergency safeguards.

## Non-Speculative Fee Economics

Citizen adopts builder-oriented fee design:

- Non-transferable fee credits.
- Credits spendable only for network execution/fees.
- Sponsored end-user operations by builders.
- Governance-controlled issuance and anti-abuse controls.

This keeps cost UX simple while preventing shilling and speculative token behavior.

## Asset Policy Direction

Implement a governed asset model with transparent controls:

- Issuer-scoped asset definitions.
- Holder opt-in trustline-like semantics.
- Authorization/revocation/clawback policy flags where explicitly enabled.
- Mandatory wallet/explorer policy disclosure for controlled assets.

## Governance Model Split

To reduce operational overload, split governance into:

- **Constitutional governance**:
  - validator set management,
  - consensus/security parameters,
  - emergency powers.

- **Product governance**:
  - namespace lifecycle,
  - builder credit policy,
  - module/contract allowlists.

## Canonical API + Receipt Unification

Citizen must define one canonical protocol contract used by all surfaces:

- Node API
- DApp backend flows
- Explorer/indexer
- Wallet/provider SDK

All write paths should yield deterministic receipts containing:

- final block reference,
- commit/finality proof,
- validation summary.

## Priority Delivery Sequence

### Phase 1 (Foundation)

- Canonical API unification.
- Signed envelope and receipt standardization.
- Explorer/indexer contract alignment.

### Phase 2 (Identity/Data Ownership)

- DID registry operations.
- Resolver service and SDK verification primitives.
- Consent receipt namespace and policy checks.

### Phase 3 (Builder Fee Credits)

- Non-transferable fee credits and sponsorship.
- Dedicated `MULTISIG_CREDIT_GRANT` policy with cryptographic proof objects (`approver`, `public_key`, `signature`) and deterministic signer verification.
- Builder registry policies and anti-abuse instrumentation.

### Phase 4 (Asset Controls)

- Governed asset module + trustline-like holding model.
- Controlled policy flags and disclosure UX.

### Phase 5 (Scoped WASM + Interop)

- Deterministic audited module runtime.
- Standards-based interop adapters.

## Documentation Alignment Rules

Any documentation that conflicts with this baseline should be updated or removed.

The following principles are authoritative for alignment:

- Namespace-first builder UX.
- Governance-controlled upgrades and module activation.
- User-owned off-chain data + on-chain verifiability.
- Non-transferable builder fee economics.
- Standards-led interoperability rollout.

## Definition of Alignment Complete

Documentation is considered aligned when:

- There is no contradictory guidance on economics, governance, or data ownership.
- Public docs consistently describe the two-plane architecture.
- Builder onboarding references canonical APIs and deterministic receipts.
- Explorer requirements include finality verification and governance transparency.
