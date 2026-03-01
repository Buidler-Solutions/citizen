# Citizen Monorepo

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
├── citizen-protocol/    # Core protocol workspace (Rust node, crates, docs, SDKs, demo/explorer/wallet)
├── landing-page/        # Government adoption landing page (frontend + backend)
├── LICENSE              # GNU Affero General Public License v3 (repository-level)
└── README.md            # This file
```

## Primary Focus: `citizen-protocol`

`citizen-protocol/` is the main implementation area for the ledger and runtime stack. It includes:

- Rust workspace crates for consensus, ledger, governance, crypto, storage, API, networking, node runtime, simulation, and wallet components.
- Protocol and operator documentation, including architecture baseline and rollout runbooks.
- Builder-facing SDK surfaces and local development/testing scripts.

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

- Repository-level license text is available at [`LICENSE`](./LICENSE) (AGPL-3.0).
- Some subprojects may include additional license files and metadata; verify each subtree as needed for distribution/compliance workflows.

## Contributing

When updating docs or architecture notes, keep protocol documentation synchronized with:

- `citizen-protocol/docs/DEEP_RESEARCH_ARCHITECTURE_BASELINE.md`

This keeps strategy, implementation, and onboarding guidance consistent across the monorepo.
