# Citizen Protocol

Citizen is a governance-first decentralized public ledger designed for public truth, records, and accountability instead of speculative finance. This repository contains the Rust implementation of the **CITIZEN** protocol, including the validator node, consensus engine, networking layer, governance system, storage adapters, simulation harness, and supporting documentation.

## Repository Layout

```text
citizen-protocol/
├── Cargo.toml                # Workspace manifest
├── crates/
│   ├── api/                  # HTTP API service (read-only + control)
│   ├── consensus/            # ≥80% quorum BFT consensus engine
│   ├── crypto/               # Signature aggregation, hashing utilities
│   ├── governance/           # Governance proposal + voting logic
│   ├── ledger/               # Namespace-aware ledger validation
│   ├── network/              # Authenticated gossip transport primitives
│   ├── node/                 # Validator / observer node binary
│   ├── simulation/           # 50–100 validator stress-test harness + golden reports
│   ├── storage/              # Persistence traits + RocksDB + in-memory backends
│   └── types/                # Shared protocol data structures
└── docs/
    ├── CITIZEN_MANIFESTO.md  # Positioning + civic mission statement
    ├── DEVELOPER_EXPERIENCE_BLUEPRINT.md # Validator + dApp + wallet + explorer + laboratory plan
    └── GOVERNANCE_CHARTER_V1.md
```


## Strategic Overhaul Baseline

Citizen's overhaul direction is defined in:

- `docs/DEEP_RESEARCH_ARCHITECTURE_BASELINE.md`

The baseline sets the authoritative plan for:

- two-plane architecture (governed namespaces + scoped audited execution),
- non-transferable builder fee credits and sponsored usage,
- user-owned data with on-chain verifiability,
- standards-led interoperability rollout, and
- canonical API + deterministic receipt unification.

Implementation handoff status is tracked in:

- `docs/PHASE_IMPLEMENTATION_TRACKER.md`

Current delivery includes Phase 2 identity/data ownership primitives, Phase 3 builder credit controls, Phase 4 governed asset controls, and Phase 5 scoped WASM + interop controls:

- DID registry namespace rule enforcement (`identity.citizen`) with governed action allowlists.
- Resolver endpoint: `GET /api/v1/identity/:did` for latest DID status (`Active`/`Revoked`).
- Consent receipt namespace policy enforcement (`consent.receipt`) and API policy checks via `POST /api/v1/consent/check`.
- Builder fee credit namespace policy enforcement (`builder.credits`) with non-transferability, sponsorship balance checks, and anti-abuse controls (`sponsorship_id` uniqueness + daily spend cap).
- Builder credit reporting endpoint: `GET /api/v1/builder-credits/:builder_id` for deterministic credited/sponsored/available accounting and instrumentation.
- Governed asset control namespace policy (`asset.control`) enforcing trustline activation, issuer-authorized holds, holder-authorized releases, and governance-scoped policy flags/disclosure commitments.
- Asset disclosure endpoint: `GET /api/v1/assets/:account_id` for trustline status, controlled policy flags, held balance, and available trustline capacity.
- Scoped WASM runtime namespace policy (`execution.module`) enforcing audit artifact requirements, governance-gated activation thresholds, and deterministic execution receipt commitments.
- Standards-based interoperability namespace policy (`interop.adapter`) enforcing governance-approved standards for adapter registration, identifier linking, and proof emission.
- Module runtime status endpoint: `GET /api/v1/modules/:module_id` for registration/activation/audit visibility.
- Interop linkage endpoint: `GET /api/v1/interop/:object_id` for latest remote identifier and proof disclosures.
- Wallet SDK verification helpers for DID document checks and off-chain commitment validation against on-chain consent receipts.

## Getting Started

1. Install the Rust toolchain (`rustup` with stable compiler).
2. Clone this repository and run the workspace build:

   ```bash
   cargo check
   ```

3. Launch a single local validator node (non-production mock network):

   ```bash
   cargo run -p citizen-node -- node.toml
   ```

   The node exposes a read-only HTTP API on `http://127.0.0.1:8080` (configurable).

4. To stand up a three-validator QUIC localnet that mirrors production settings,
   use the deterministic configs under `config/localnet/` and the helper
   launcher:

   ```bash
   scripts/run_localnet.sh
   ```

   See `docs/LOCALNET_RUNBOOK.md` for details on swapping in your own keys and
   endpoints for a real deployment.

   For running the validator localnet together with the demo blog, browser
   wallet extension, and blockchain explorer (backend + frontend), follow
   `docs/STACK_TESTING_GUIDE.md`.

5. When promoting deployments beyond a single host, use the staged network
   manifests:

   - `testnets/testnet.toml` — shared integration testnet manifest for partner
     QA and compatibility validation.
   - `testnets/futurenet.toml` — developer-stage futurenet for governance
     rehearsals and upgrade validation.
   - `testnets/mainnet.toml` — public mainnet manifest with governance-approved
     validator anchors.
   - `config/testnet/validator-sample.toml` — sample per-operator testnet
     configuration template.
   - `config/futurenet/validator-sample.toml` — sample per-operator futurenet
     configuration template (existing `validator-alpha/beta/gamma` files remain
     available for deterministic staged setups).
   - `config/miannet/validator-sample.toml` — sample mainnet-like ("miannet")
     operator configuration template.

   Additional context is available in `docs/NETWORKS.md`.

   Operator disaster-recovery procedures (snapshot/restore drills, signed retention, quorum-safe regional restore) are documented in:

   - `docs/OPERATOR_DISASTER_RECOVERY_RUNBOOK.md`

   Observer/watcher rollout profile (read-only runtime mode, bootstrap template, and onboarding checks) is documented in:

   - `docs/OBSERVER_NODE_RUNBOOK.md`

   Validator rollout readiness gate (keys, admission policy, telemetry, and runbook sign-off) is documented in:

   - `docs/VALIDATOR_ROLLOUT_READINESS.md`

### Running a compiled node binary in production

If you already compiled the runtime, you can run the binary directly without
`cargo run`:

1. Build a release binary once on your build host:

   ```bash
   cargo build --release -p citizen-node
   ```

2. Copy `target/release/citizen-node` and your vetted operator config onto the
   production node (for example, a copy of
   `config/miannet/validator-sample.toml` with all placeholders replaced).

3. Start the process by pointing the binary at your config file:

   ```bash
   ./citizen-node /etc/citizen/node.toml
   ```

4. Set `RUST_LOG=info` (or stricter) and run under a process supervisor
   (`systemd`, `supervisord`, or container orchestrator) for restart-on-failure
   behavior and centralized logs.

5. Keep `manifest_enforce = true`, configure production `[[validators]]` and
   `[[peers]]` allowlists, and rotate network keys via
   `network_key_rotation_secs` according to governance policy.

6. Validate operational readiness using:
   - `docs/VALIDATOR_ROLLOUT_READINESS.md`
   - `docs/OPERATOR_DISASTER_RECOVERY_RUNBOOK.md`
   - `docs/NETWORK_ADMISSION_TROUBLESHOOTING_RUNBOOK.md`

7. For a consolidated builder + user enablement guide (validator setup, dApp
   flow, signer keeper usage, explorer verification, and Laboratory app plan),
   read:

   - `docs/DEVELOPER_EXPERIENCE_BLUEPRINT.md`

## Transport Admission & Key Rotation

- Incoming QUIC/libp2p peers are validated against the configured validator snapshot in `node.toml`. Use
  `[[validators]]` entries to define the allowlist (validator ID + verifying key) that peers must present
  during handshake.
- Configure `network_key_rotation_secs` to control how frequently nodes refresh their network key epoch
  and re-authenticate peers. The default rotation cadence is one hour.

## Simulation Harness

The `citizen-simulation` crate runs deterministic stress scenarios for validator sets between 50 and 100 participants. Example CLI entry point (add inside your own binary or `cargo run -p citizen-simulation` harness):

```rust
use citizen_types::{SimulationConfig, SimulationScenario, NetworkModel};
use citizen_simulation::SimulationHarness;
use std::time::Duration;

#[tokio::main]
async fn main() {
    let config = SimulationConfig {
        validators: 75,
        scenario: SimulationScenario::PartialFailure,
        network: NetworkModel {
            same_region_rtt_ms: (20, 50),
            cross_region_rtt_ms: (80, 180),
            jitter_ms: 20,
            packet_loss: 0.01,
        },
    };

    let harness = SimulationHarness::new(config).expect("simulation init");
    let report = harness
        .execute(Duration::from_secs(15))
        .await
        .expect("simulation run");
    println!("Final heights: {:?}", report.final_heights);
}
```

The harness covers the RFC scenarios: normal operation, partial outages, quorum loss, malicious leaders, byzantine subsets, and partitions.

## Testnet Outline

- Bootstrap 50 validator identities across partner institutions; preload their verifying keys into a genesis `ValidatorSetSnapshot`.
- Publish a testnet manifest (`testnets/copper.toml`) capturing namespace definitions, bootstrapping peers, and governance parameters.
- Run the simulation harness with matching validator count before testnet launch; share the report publicly.
- Roll out staged activations: observers connect first, then validators join in cohorts of five with governance-confirmed admission blocks.
- Require on-chain governance proposals for every validator addition or parameter change during testnet.

## GitHub Organization Blueprint

- **Organization name:** `citizen-protocol`
- **Repositories:**
  - `citizen-protocol` – this workspace
  - `citizen-specs` – protocol specification + AGENTS.md history
  - `citizen-grants` – grant proposals, community funding rounds
- **Teams:**
  - `core-governance` (write access to governance + specs)
  - `protocol-engineering` (workspace maintainers)
  - `simulation-lab` (testnet + harness maintainers)
- **Default branch protections:**
  - Linear history, required reviews from `protocol-engineering`
  - Mandatory status checks: `cargo fmt`, `cargo clippy -- -D warnings`, `cargo test`, `cargo nextest` (when added)

## Contributing

1. Fork & branch from `main`.
2. Run `cargo fmt` + `cargo clippy -- -D warnings` from the `citizen-protocol/` workspace root (the monorepo parent only hosts the workspace as a subdirectory).
3. Add targeted tests or simulation cases that cover new logic.
4. Document governance or namespace changes under `docs/` and the changelog (pending).

## Next Steps

- Harden the QUIC/libp2p authenticated gossip transport with peer admission policies and rotating keys.
- Benchmark the RocksDB storage adapter under concurrent writer load and tune compaction policies.
- Expand simulation fixtures to export CI-published golden reports for each tagged release.

## License

Licensed under [Apache License 2.0](LICENSE).
