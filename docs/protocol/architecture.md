# Architecture

Citizen uses a modular, two-plane architecture designed for governance-first ledger operations.

## System Overview

```
┌──────────────────────────────────────────────────────────┐
│                    CITIZEN NODE RUNTIME                    │
│                                                            │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐ │
│  │ Network  │  │ Consensus│  │  Ledger  │  │Governance│ │
│  │ (QUIC)   │  │ (BFT)    │  │ (Policy) │  │ (Votes)  │ │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘ │
│       │              │              │              │       │
│  ┌────┴──────────────┴──────────────┴──────────────┴───┐ │
│  │              Storage (RocksDB)                        │ │
│  └──────────────────────────────────────────────────────┘ │
│                                                            │
│  ┌──────────┐  ┌──────────────────────────────────────┐   │
│  │ Execution│  │              API Layer (HTTP/REST)    │   │
│  │ (WASM)   │  └──────────────────────────────────────┘   │
│  └──────────┘                                              │
└──────────────────────────────────────────────────────────┘
```

## Crates

| Crate | Responsibility |
|-------|---------------|
| `types` | Core protocol types (entries, receipts, envelopes) |
| `crypto` | Ed25519, X25519, hashing, signature verification |
| `network` | QUIC-based peer-to-peer networking |
| `consensus` | Linear BFT consensus with >2/3 quorum |
| `ledger` | Namespace-aware entry validation and policy enforcement |
| `governance` | Proposals, voting, quorum, namespace activation |
| `storage` | RocksDB-backed persistent storage |
| `execution` | WASM smart contract engine (wasmtime 36, sandboxed) |
| `module-sdk` | No-alloc Rust SDK for writing WASM modules |
| `api` | HTTP REST API for builders and wallets |
| `node` | Node runtime — ties everything together |
| `simulation` | Multi-validator test harness |
| `wallet` | Key custody, signing, wallet core |

## Node Modes

A Citizen node can operate in two modes:

### Validator

Validators participate in consensus. They propose and vote on blocks, maintain the ledger, and serve API requests. Validators must pass admission preflight and be recognized by the network.

### Observer

Observers replicate the ledger and serve API requests but do not participate in consensus voting. They provide independently verifiable read access without the overhead of consensus participation.

## Data Flow

1. **Submit** — A builder submits a signed entry via the API
2. **Validate** — The ledger validates the entry against namespace policies
3. **Propose** — The leader includes valid entries in a proposed block
4. **Vote** — Validators vote on the proposed block (>2/3 required)
5. **Commit** — Upon supermajority, the block is finalized deterministically
6. **Receipt** — A deterministic receipt is generated and made available via API

## Storage

The node uses RocksDB for persistent storage. Data is organized by namespace with separate column families for:

- Entries (committed transactions)
- Receipts (finality proofs)
- Governance proposals and votes
- Namespace configurations and policies

## API Layer

The HTTP API exposes endpoints for:

- Entry submission and receipt lookup
- Namespace management and policy queries
- Governance proposals and voting status
- Health checks and node status
- Off-chain encrypted file workflows (when enabled)
