# Overview

Citizen is a **governance-first, permissioned BFT consensus blockchain** built for verifiable public truth infrastructure. It prioritizes deterministic outcomes, namespace-scoped governance, and user-owned data custody over speculative token economics.

## Core Principles

### 1. Governed Data Plane First

Namespaces are the fundamental unit of organization. Each namespace has its own policies, consent rules, privacy controls, and admission criteria — all governed through on-chain proposals.

### 2. Deterministic Finality

Citizen uses linear BFT consensus with a >2/3 supermajority (6667 bps) quorum. Finality is deterministic and achieved in approximately 1 second. There are no probabilistic confirmations.

### 3. User-Owned Data Custody

Commitments and proofs live on-chain. Encrypted user-controlled data lives off-chain by default. Users control who can decrypt their data through hybrid ACL/DEK-based sharing.

### 4. Builder-First Usability

Canonical APIs, SDK ergonomics, local-stack onboarding, and deterministic behavior are first-class priorities. Builder fee credits and sponsored usage replace speculative token-gas models.

### 5. Standards-Led Interoperability

Interop adapters are governed and explicit. Cross-chain or cross-system bridges require governance approval and namespace-level activation.

## Two-Plane Architecture

```
┌─────────────────────────────────────────────────┐
│                 GOVERNED DATA PLANE              │
│                                                   │
│  Namespaces · Policies · Receipts · Governance   │
│  (Default path — always available)               │
└─────────────────────────────────────────────────┘
                        │
┌─────────────────────────────────────────────────┐
│              OPTIONAL EXECUTION PLANE             │
│                                                   │
│  Scoped WASM modules · Audited · Governance-gated│
│  (Activated per-namespace with approval)         │
└─────────────────────────────────────────────────┘
```

- **Governed Data Plane** — the default operating mode. Entries are validated against namespace policies, signed, committed, and produce deterministic receipts.
- **Execution Plane** — optional, scoped, audited WASM execution that a namespace must explicitly activate through governance.

## Implementation Status

The Rust workspace (`citizen-protocol/`) contains a running implementation of:

- Validator and observer node runtime
- Namespace-aware ledger with policy enforcement
- BFT consensus engine with quorum evaluation
- Governance proposal/voting/activation system
- Canonical HTTP API layer
- Simulation harness for multi-validator scenarios
- Wallet core with key custody and signing

## Next Steps

- [Install the protocol and tooling](installation.md)
- [Run a quick local network](quickstart.md)
- [Learn about the consensus model](../protocol/consensus.md)
- [Choose a wallet](../wallets/overview.md)
