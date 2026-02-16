# Citizen Network Profiles

Citizen deployments progress through three standard environments. Each stage
shares the same namespace governance and quorum rules while widening the set of
operators, endpoints, and observability hooks.

## Localnet (Developer Solo / CI)
- **Purpose:** Fast feedback for protocol hacking on a single host.
- **Artifacts:** `config/localnet/*.toml` and `scripts/run_localnet.sh` (QUIC
enabled, deterministic keys).
- **Operators:** Single developer machine.
- **Admission:** Hardcoded allowlist between the three bundled validators.
- **Notes:** Swap keys and bind addresses per `docs/LOCALNET_RUNBOOK.md` when
  testing realistic key material.

## Testnet (Shared Integration)
- **Purpose:** Shared integration environment between localnet and futurenet for
  partner QA and API compatibility checks.
- **Artifacts:** `testnets/testnet.toml` manifest and
  `config/testnet/validator-sample.toml` operator template.
- **Operators:** Limited set of partner validators and observers.
- **Admission:** Manifest-backed allowlist with governance-gated membership.
- **Notes:** Use this stage to validate client integrations before futurenet
  governance rehearsals.

## Futurenet (Developer Stage)
- **Purpose:** Multi-operator staging network to exercise upgrades, governance
  flows, and namespace validation with remote peers.
- **Artifacts:** `testnets/futurenet.toml` manifest plus per-operator `node.toml`
  derived from it (starter templates: `config/futurenet/validator-*.toml` and `config/futurenet/validator-sample.toml`).
- **Operators:** Small, invite-only group of development validators and
  observers.
- **Admission:** Pre-approved validator IDs and verifying keys; new entrants go
  through governance voting before inclusion.
- **Notes:** Treat as pre-production: run with production-like monitoring,
  capture telemetry (finality p50/p95, aborted rounds, leader rotations,
  message volume, CPU/RAM), and publish upgrade playbooks after each change.
  Before release promotion, execute `scripts/run_simulation_release_gate.sh` to
  publish Section 19 simulation artifacts (50/75/100 validators x all
  adversarial scenarios) under `reports/releases/`.

## Mainnet (Public)
- **Purpose:** Long-lived public ledger for identity, land registry, audit, and
  governance namespaces.
- **Artifacts:** `testnets/mainnet.toml` manifest (production genesis snapshot)
  and published governance charter. A mainnet-like sample operator template is available at `config/miannet/validator-sample.toml`.
- **Operators:** Governance-approved validator institutions; observers welcome.
- **Admission:** On-chain governance approval (≥80% quorum) with documented
  identity anchors for each validator.
- **Notes:** Enforce HSM-backed signing keys, hardened QUIC endpoints, monitoring
  hooks, and compliance with the public governance ruleset.
