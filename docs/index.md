# Citizen Protocol

Welcome to the **Citizen Protocol** documentation - a governance-first ledger for public truth, records, and institutional accountability.

---

## What is Citizen?

Citizen is a **governed, namespace-first blockchain protocol** designed for verifiable public truth infrastructure without speculative-currency mechanics. It provides:

- **Deterministic finality** (~1s) through linear BFT consensus with >2/3 supermajority quorum
- **Governance-first design** where namespaces, policies, and admissions are all governed
- **User-owned data custody** with on-chain commitments and off-chain encrypted storage
- **Builder-friendly APIs** with SDKs, canonical endpoints, and local-stack tooling
- **Non-speculative economics** using builder fee credits and sponsored usage

## Monorepo Components

| Component | Description |
|-----------|-------------|
| `citizen-protocol/` | Core Rust protocol workspace (node, consensus, ledger, governance, crypto, storage, API) |
| `wallet/` | Wallet surfaces - CLI, browser extension, mobile (Flutter), desktop (Tauri), React console |
| `sdk/` | TypeScript SDK for builder integrations |
| `explorer/` | Block and transaction explorer |
| `compliance/` | GDPR compliance, data inventory, processing records |
| `security/` | Security policies (backup, DR, encryption, incident response) |

## Quick Links

- :rocket: **[Getting Started](getting-started/overview.md)** - overview and architecture primer
- :package: **[Installation](getting-started/installation.md)** - set up the protocol and tooling
- :zap: **[Quick Start](getting-started/quickstart.md)** - run a local network in minutes
- :wallet: **[Wallets](wallets/overview.md)** - choose and use a Citizen wallet
- :coder: **[TypeScript SDK](sdk/typescript.md)** - integrate Citizen into your application
- :server: **[Node Operators](node-operators/running-a-node.md)** - run validators and observers

## License

- Repository-level: **Apache License 2.0** - see [LICENSE](https://github.com/Buidler-Solutions/citizen/blob/main/LICENSE)
