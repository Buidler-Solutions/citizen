# Citizen Monorepo Agent Guide

## Status
Implementation-aware contributor guide for the current monorepo.

This repository is no longer just a high-level protocol sketch. The codebase already contains a substantial Rust implementation of the Citizen protocol stack, plus SDK, wallet, explorer/demo surfaces, and a government-adoption landing page. Agents should treat the implementation as the primary source of truth and keep top-level documentation aligned with the active baseline in `citizen-protocol/docs/DEEP_RESEARCH_ARCHITECTURE_BASELINE.md`.

## Monorepo Layout

```text
.
├── AGENTS.md                  # This repo-wide guide
├── README.md                  # Monorepo overview
├── citizen-protocol/          # Main Rust protocol workspace
│   ├── crates/                # Rust protocol/runtime crates
│   └── docs/                  # Architecture, runbooks, readiness reviews, rollout plans
├── sdk/                       # Builder-facing SDKs
├── wallet/                    # CLI + browser/react wallet surfaces
├── explorer/                  # Explorer backend/frontend
├── demo/                      # Demo application
├── dapp/                      # dApp surfaces and local-stack pieces
├── whitepaper/                # Whitepaper surface
└── landing-page/              # Separate marketing/government adoption app
```

## Current Codebase Reality

When describing the project, prefer the implemented shape of the repository:

- **Rust workspace is real and active.** The `citizen-protocol/Cargo.toml` workspace includes `types`, `crypto`, `consensus`, `ledger`, `governance`, `network`, `storage`, `api`, `node`, `simulation`, `wallet`, and `wallet/cli` crates.
- **Validator/observer runtime exists.** `crates/node` starts a node, loads config, runs admission preflight, opens RocksDB storage, boots namespaces, serves the API, and runs validator consensus or observer mode depending on configuration.
- **Namespace-aware ledger enforcement exists.** `crates/ledger` validates entries with configured namespace rules, including signature checks, consent policy, builder-credit policy, privacy policy, asset-control policy, WASM runtime policy, and interop adapter policy.
- **Governance logic exists.** `crates/governance` tracks proposals/votes, evaluates quorum, and validates namespace activation readiness.
- **Builder/API surface exists.** `crates/api` exposes protocol-facing HTTP endpoints and also contains off-chain object-store support for encrypted file workflows.
- **Simulation harness exists.** `crates/simulation` runs multi-validator scenarios for normal operation, partial failure, quorum loss, malicious leader, Byzantine subsets, and network partitions.
- **Wallet/privacy implementation exists.** The wallet crate and docs support consent receipts, encrypt-then-commit flows, selective field privacy, and hybrid ACL/DEK-based sharing.
- **Builder-facing SDK exists.** `sdk/typescript` is a first-class integration surface and should be treated as part of the core product story, not as a placeholder.
- **Off-chain encrypted-file runtime path is implementation-aware but deployment-optional.** API and policy checks are implemented; production object-store wiring is profile/config dependent. Treat off-chain encrypted storage as a floating option for large encrypted artifacts when namespace on-chain-accepted size constraints are exceeded.

## Strategic Direction to Preserve

All documentation and implementation planning should remain consistent with these active themes:

1. **Governed data plane first.** Namespaces, deterministic receipts, policy enforcement, and governance are the default path.
2. **Scoped execution second.** Execution modules/WASM are optional, audited, and governance-gated.
3. **Builder-first usability.** Favor canonical APIs, SDK ergonomics, local-stack onboarding, and deterministic behavior.
4. **User-owned data custody.** Keep commitments/proofs on-chain and encrypted user-controlled data off-chain by default.
5. **Non-speculative economics.** Preserve builder credits and sponsored usage; avoid token-first framing.
6. **Standards-led interoperability.** Interop adapters must remain governed and explicit.

## How Agents Should Work In This Repo

### 1. Prefer implementation evidence over stale prose
If a document sounds more aspirational than the codebase, inspect the relevant crates/readmes/runbooks and update the document to reflect what is actually implemented.

### 2. Keep top-level docs synchronized
For changes affecting project positioning, architecture summaries, or contributor guidance, check alignment among:
- `AGENTS.md`
- `README.md`
- `citizen-protocol/README.md`
- `citizen-protocol/docs/DEEP_RESEARCH_ARCHITECTURE_BASELINE.md`

### 3. Keep Citizen protocol messaging accurate
Describe Citizen as:
- governance-first,
- namespace-first,
- deterministic/finality-oriented,
- builder-facing,
- privacy-aware,
- non-speculative by default.

Do **not** reduce the project to “just a whitepaper” when the repository clearly contains running implementation work.

### 4. Respect subtree instructions
More specific `AGENTS.md` files override this guide within their directories. Example: `landing-page/backend/AGENTS.md` applies inside that subtree.

### 5. Avoid broad speculative claims
Do not claim production readiness, security guarantees, or deployment completeness beyond what the code/docs explicitly support. Prefer wording such as “implemented in the current workspace”, “supported by the current node/API/wallet stack”, or “documented in runbooks/readiness reviews”.

## Practical Review Checklist For Documentation Changes

Before editing architecture or contributor-facing docs, quickly verify:

- Which crates/services already exist.
- Which features are implemented versus planned.
- Whether corresponding runbooks or readiness reviews already document the feature.
- Whether the change should mention SDK, wallet, explorer, demo, or local-stack workflows in addition to the core Rust crates.

## Useful Commands

From the repository root:

```bash
rg --files .
```

For the protocol workspace:

```bash
cd citizen-protocol
cargo check
cargo test
```

Common targeted checks:

```bash
cargo test -p citizen-governance
cargo test -p citizen-ledger
cargo test -p citizen-simulation
cargo test -p citizen-wallet
```

## Documentation Tone

Use language that matches the current state of the repository:

- confident about implemented modules,
- careful about readiness claims,
- explicit about governance constraints,
- consistent with the deep-research baseline,
- helpful to builders/operators reviewing the repo.

## Summary

Citizen is currently best understood as an **implementation-forward, governance-first ledger monorepo** with a substantial Rust runtime, policy-aware ledger, governance engine, API layer, wallet/privacy work, simulation tooling, and builder-facing SDK/documentation. Agents should update docs and guidance accordingly.
