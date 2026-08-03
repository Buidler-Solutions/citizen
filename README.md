# Citizen Monorepo

[![Protocol](https://img.shields.io/badge/Protocol-CITIZEN-2d6cdf)](./citizen-protocol/README.md)
[![Status](https://img.shields.io/badge/Status-Working%20Draft-orange)](./AGENTS.md)
[![Consensus](https://img.shields.io/badge/Consensus-BFT%20%3E2/3%20quorum-6f42c1)](./AGENTS.md)
[![Finality](https://img.shields.io/badge/Finality-Deterministic%20~1s-success)](./AGENTS.md)
[![Rust](https://img.shields.io/badge/Rust-Workspace-000000?logo=rust)](./citizen-protocol/Cargo.toml)
[![License: CPNCL](https://img.shields.io/badge/License-CPNCL%20v1.0-blue)](./LICENSE)

This repository is the monorepo for **Citizen**, a governance-first public-ledger initiative centered on the **CITIZEN protocol**.

The protocol mission is to provide verifiable public truth infrastructure (records, accountability, governance, and civic coordination) without speculative-currency design as the core value proposition.

## Monorepo Goals

- Keep protocol, tooling, SDK, and product surfaces in one auditable workspace.
- Prioritize **governed, namespace-first ledger design** with deterministic outcomes.
- Support builders with practical APIs, SDK workflows, and local-stack onboarding.
- Maintain documentation and implementation alignment with the deep-research architecture baseline.

## Repository Structure

```text
.
├── citizen-protocol/    # Core Rust protocol workspace (node, crates, docs, config, scripts)
├── sdk/                 # Builder-facing SDKs (Node.js package + docs)
├── wallet/              # Wallet surfaces (CLI + browser + React + mobile + desktop)
├── explorer/            # Explorer backend/frontend + infra
├── demo/                # Demo application surface
├── dapp/                # dApp surfaces and local-stack pieces
├── whitepaper/          # Whitepaper web/docs surface (deployed to GitHub Pages)
├── landing-page/        # Government adoption landing page (frontend + backend)
├── compliance/          # GDPR compliance, data inventory, processing records
├── controls/            # Blockchain + GDPR control packs
├── security/            # Security policies (backup, DR, encryption, incident response)
├── .ges/                # GESF compliance framework configuration and evidence
├── .github/workflows/   # CI (compliance, dependency scan, secret scan, security, Pages)
├── LICENSE              # Citizen Protocol Non-Commercial License (CPNCL) v1.0
└── README.md            # This file
```

## Primary Focus: `citizen-protocol`

`citizen-protocol/` is the main implementation area for the ledger and runtime stack. It includes:

- Rust workspace crates for consensus, ledger, governance, crypto, storage, API, networking, node runtime, simulation, and wallet components.
- Protocol and operator documentation, including architecture baseline and rollout runbooks.
- Local-stack product surfaces at monorepo root (`sdk/`, `wallet/`, `explorer/`, `demo/`, and `dapp/`).

See: `citizen-protocol/README.md` for module-level details and run instructions.

## CITIZEN Protocol Direction (Current)

The active direction emphasizes:

1. **Two-plane architecture**
   - Governed Data Plane (default path)
   - Optional, scoped, audited, governance-gated execution plane

2. **Builder-first product surface**
   - Canonical APIs
   - Deterministic receipts
   - SDK usability and onboarding

3. **User data ownership model**
   - On-chain commitments/proofs/events
   - Off-chain encrypted user-controlled custody by default

4. **Standards-led interoperability**
   - Staged rollout with governance review

5. **Non-speculative economics**
   - Builder fee credits and sponsored usage over speculative token-first design

## Implementation Status Snapshot (2026-08-03)

- The Rust runtime, ledger policy engine, governance workflows, and canonical API
  surfaces are implemented in the current workspace.
- Off-chain encrypted file workflows are implemented as a governance/policy-aware
  API path, but production object-store execution remains operator-configurable
  (`api_offchain_encrypted_files_v1_enabled` + optional MinIO config) rather than
  universally enabled by default.
- Documentation and planning should treat off-chain encrypted object handling as
  an active **floating task/option** for large encrypted artifacts when a
  namespace's on-chain-accepted size/profile is insufficient for direct payload
  handling.


## Wallet System Tech-Stack (Cross-Monorepo)

When we refer to the **wallet system tech-stack**, this includes all of the following coordinated surfaces:

1. **Citizen protocol node runtime (`citizen-protocol/`)**
   - Canonical envelope/receipt APIs and deterministic validation/finality behavior.
2. **Landing-page app-builder surface (`landing-page/`)**
   - Builder-facing application workflow where user forms and onboarding UX are defined.
3. **Wallet SDK (`sdk/typescript/`)**
   - Builder integration layer for provider access, canonicalization, transaction submission, and wallet signing helpers.
4. **Wallet browser extension (`wallet/browser/`)**
   - User custody surface for account management, consented signing, dApp login, decryption, and protocol payload commitment generation.
5. **Wallet mobile app (`wallet/mobile/`)**
   - Flutter-based client-facing mobile wallet with WalletConnect dApp integration, transaction signing, hybrid decryption, vault management, and direct submit. Supports both iOS and Android.
6. **Wallet desktop app (`wallet/desktop/`)**
   - Tauri-based desktop wallet with Rust bridge for backup vault operations.
7. **Wallet CLI (`citizen-protocol/crates/wallet`, `wallet/cli`)**
   - Operator/developer wallet workflows and cryptographic parity reference for canonical signing behavior.
8. **Wallet auth backend (`wallet/backend/`)**
   - Challenge/verify login APIs for dApp authentication flows.

Design changes touching user-data separation should be evaluated across this full stack, not as isolated extension-only behavior.

### Crypto Parity Across Wallet Surfaces

All wallet surfaces share the same derivation chain to ensure cross-platform key compatibility:

```
BIP39 mnemonic → PBKDF2-HMAC-SHA512 (2048 iters) seed → SLIP-0010 m/44'/930'/0'/0'/0'
                                                                        │
                                                  ┌───────────────────────┴───────────────────────┐
                                                  ▼                                               ▼
                                          Ed25519 signer                                 X25519 reader
                                          (did:key:ed25519:)                             (did:key:x25519:)
                                          Transaction signing                            Data decryption
```

A mnemonic imported on any surface (CLI, browser, mobile, desktop) derives the same Ed25519/X25519 key material.

## Quick Start

### Protocol workspace

```bash
cd citizen-protocol
cargo check
```

### Landing page workspace

```bash
cd landing-page
# follow landing-page/README.md setup steps
```

## Licensing

- Repository-level license text is available at [`LICENSE`](./LICENSE) (Citizen Protocol Non-Commercial License v1.0).
- `citizen-protocol/` includes its own [`LICENSE`](./citizen-protocol/LICENSE) (Apache License 2.0).
- Some subprojects may include additional license files and metadata; verify each subtree as needed for distribution/compliance workflows.

## Contributing

When updating docs or architecture notes, keep protocol documentation synchronized with:

- `citizen-protocol/docs/DEEP_RESEARCH_ARCHITECTURE_BASELINE.md`

This keeps strategy, implementation, and onboarding guidance consistent across the monorepo.
