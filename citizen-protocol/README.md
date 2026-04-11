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

Related monorepo surfaces now live at repository root:

- `../sdk/nodejs` — Node.js SDK for dApp builders.
- `../wallet` — wallet CLI, browser extension, and React surface.
- `../explorer` — explorer backend/frontend stack.
- `../demo` and `../dapp` — demo + dApp integration surfaces.

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

## Feasibility Note: "Institutional Integrity" Runtime Diagrams

Citizen's existing runtime is already designed for that model at the
architecture level, and the current implementation is on that path.

Conceptual diagrams that show one shared blockchain runtime serving domains like
voting, finance, health records, and supply chain are directionally compatible
with Citizen's architecture, with one critical constraint: those domains must be
implemented as governed namespaces (and optionally governance-gated execution
modules), not as unconstrained app logic.

In practical terms:

- **Possible now**: a shared, permissioned validator runtime with deterministic
  finality, transparent verification paths, and cryptographically controlled
  off-chain data custody commitments.
- **Required before production**: per-namespace governance approvals, explicit
  write/validation rules, privacy/data custody policies, and staged
  interoperability controls.
- **Out of scope by default**: permissionless validator churn, speculative token
  economics, or ad-hoc cross-domain integrations bypassing governance.

This keeps "institutional integrity" as a real implementation target while
preserving Citizen's governance-first safety model.

Current delivery includes Phase 2 identity/data ownership primitives, Phase 3 builder credit controls, Phase 4 governed asset controls, and Phase 5 scoped WASM + interop controls:

- DID registry namespace rule enforcement (`identity.citizen`) with governed action allowlists.
- Resolver endpoint: `GET /api/v1/identity/:did` for latest DID status (`Active`/`Revoked`).
- Consent receipt namespace policy enforcement (`consent.receipt`) and API policy checks via `POST /api/v1/consent/check`.
- Form commitment namespace policy enforcement (`forms.commitment`) with deterministic required payload fields (`data_hash`, `encrypted_form_url`) for anchoring encrypted form references as on-chain commitments.
- Builder fee credit namespace policy enforcement (`builder.credits`) with non-transferability, mandatory `MULTISIG_CREDIT_GRANT` opcode usage, approver-to-public-key binding via configured `grant_approvers` entries (`id`, `public_key`), required `payload.multisig_proofs` (`approver`, `public_key`, `signature`) with deterministic ledger-side signature verification, mandatory `payload.credit_grant_id` linkage for `SPONSOR_USAGE`, sponsorship balance checks, and anti-abuse controls (`sponsorship_id` uniqueness + daily spend cap).
- Builder credit reporting endpoint: `GET /api/v1/builder-credits/:builder_id` for deterministic credited/sponsored/available accounting, active policy metadata (including `max_daily_spend`), and sponsorship instrumentation.
- Strict API write gating now requires `payload.credit_grant_id` linkage for submit/envelope writes and offchain envelope commit/revoke flows, with optional `payload.sponsor_builder_id` for builder-sponsored user actions.
- Detailed 3-of-5 multisig implementation and operations guide for builder credit grants: `docs/MULTISIG_3_OF_5_IMPLEMENTATION_HOWTO.md`.
- Governed asset control namespace policy (`asset.control`) enforcing trustline activation, issuer-authorized holds, holder-authorized releases, and governance-scoped policy flags/disclosure commitments.
- Asset disclosure endpoint: `GET /api/v1/assets/:account_id` for trustline status, controlled policy flags, held balance, and available trustline capacity.
- Scoped WASM runtime namespace policy (`execution.module`) enforcing audit artifact requirements, governance-gated activation thresholds, and deterministic execution receipt commitments.
- Standards-based interoperability namespace policy (`interop.adapter`) enforcing governance-approved standards for adapter registration, identifier linking, and proof emission.
- Module runtime status endpoint: `GET /api/v1/modules/:module_id` for registration/activation/audit visibility.
- Interop linkage endpoint: `GET /api/v1/interop/:object_id` for latest remote identifier and proof disclosures.
- Wallet SDK verification helpers for DID document checks and off-chain commitment validation against on-chain consent receipts.
- Node.js dApp SDK is working and ready for builder integration, with canonical envelope submit + deterministic receipt retrieval plus first-class builder-credit helpers (`createMultisigCreditGrant`, `createSponsorshipUsage`) and pre-submit payload validation: `sdk/nodejs/README.md`.
- Wallet opt-in privacy modes now include both full encrypt-then-commit and field-selective encryption (`public_fields` + encrypted `private_fields` + `public_allowlist`) with canonical commitment checks, Argon2id + ChaCha20-Poly1305 payload protection, and embedded consent receipts for governance/audit compliance while keeping public clear-text as the default mode.
- Encrypt-then-commit is explicitly opt-in and supports two protected paths: (a) passphrase-protected mode for user-managed sharing and (b) ACL + DEK hybrid mode for reader-scoped access control.
- Hybrid privacy mode enforces reader ACL + DEK wrapping semantics for both full-payload and per-field commit workflows: each authorized reader receives an X25519-wrapped DEK, `field_reader_acls` scopes access by field, and all flows keep deterministic `payload_commitment` anchoring so node, wallet, and explorer contracts stay verifiable.
- Off-chain encrypted attachment workflows now also support reader-key hybrid decrypt/encrypt in wallet APIs (`encrypt_offchain_file_reader_to_writer_hybrid` / `decrypt_offchain_file_reader_to_writer_hybrid`) so authorized readers can decrypt with their own keys without passphrase exchange.
- Privacy options are now documented as four operator/builder choices: `none` (default clear-text), `passphrase` encrypt-then-commit, `hybrid_full_payload` (ACL + DEK), and `hybrid_selective_fields` (ACL + DEK + per-field visibility).

## Getting Started

1. Install the Rust toolchain (`rustup` with stable compiler).
2. Clone this repository and run the workspace build:

   ```bash
   cargo check
   ```

Quick wallet encrypt-then-commit smoke check (avoids brittle multiline shell copy/paste):

```bash
scripts/run_wallet_encrypt_then_commit_smoke.sh
```

Quick wallet selective field-encryption smoke check:

```bash
scripts/run_wallet_selective_encrypt_then_commit_smoke.sh
```

ACL + DEK coverage smoke check (hybrid mode, per-field ACL propagation, and per-payload commit verification):

```bash
cargo test -p citizen-wallet privacy_mode_hybrid_ -- --nocapture
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

   For a production-like real-runtime integration checklist where demo blog, wallet, and explorer all target the same node runtime, use `docs/REAL_NODE_RUNTIME_RUNBOOK.md`.

   For batch envelope submit walkthroughs (single-request multi-envelope commit + verification), use `docs/BATCH_ENVELOPE_SUBMISSION_RUNBOOK.md`.

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

### Network runtime one-liners (from repository root)

If your node startup command fails in admission mode, the most common missing
piece is the config file argument after `--` (and, from the monorepo root, the
workspace `--manifest-path`). Use these one-liners with your operator config
that has real keys/secrets populated:

- **Testnet**

  ```bash
  RUST_LOG=info cargo run --release -p citizen-node --manifest-path citizen-protocol/Cargo.toml -- citizen-protocol/config/testnet/validator-sample.toml
  ```

- **Futurenet**

  ```bash
  RUST_LOG=info cargo run --release -p citizen-node --manifest-path citizen-protocol/Cargo.toml -- citizen-protocol/config/futurenet/validator-alpha.toml
  ```

- **Mainnet profile**

  ```bash
  RUST_LOG=info cargo run --release -p citizen-node --manifest-path citizen-protocol/Cargo.toml -- citizen-protocol/config/miannet/validator-sample.toml
  ```

For production hosts running a prebuilt binary, the equivalent form is:

```bash
RUST_LOG=info ./citizen-node /etc/citizen/node.toml
```

If you isolate the runtime outside this monorepo (for example, `citizen-node`
and `node.toml` in the same deployment folder), **you do not need**
`--manifest-path` because that flag is only for Cargo workspace discovery. Run:

```bash
RUST_LOG=info ./citizen-node ./node.toml
```

If your `node.toml` references `manifest_path`, keep that path valid relative to
where the process starts (or use an absolute path).

### Optional: auto-promote standby runtime helper

If an operator wants runtime role toggling to follow governance rotations, this
helper can watch governance rotation proposals and automatically:

1. detect when your `validator_id` appears in the active set,
2. set `standby_only = false` when active and `standby_only = true` when standby,
3. restart the node process whenever the local runtime mode needs to change.

```bash
VALIDATOR_ID=validator.alpha \
CONFIG_PATH=/etc/citizen/node.toml \
NODE_BIN=./citizen-node \
API_BASE_URL=http://127.0.0.1:8081 \
citizen-protocol/scripts/auto_promote_standby.sh
```

The helper expects `GET /api/v1/governance/proposals` and requires `curl` + `jq`.
It runs continuously so promotion and demotion transitions are both automated.

### About `manifest_path` in `validator-sample.toml`

`config/*/validator-sample.toml` files intentionally keep
`manifest_path = "REPLACE_WITH_SIGNED_MANIFEST_JSON_PATH"` so operators do not
accidentally boot a shared network with an unsigned or stale allowlist.

- On **testnet/futurenet/mainnet**, replace this with the signed admission
  manifest JSON published by release/governance operations for that network.
- On **local development only**, you can disable enforcement by setting
  `manifest_enforce = false` and removing `manifest_path` from your copied
  config.

If you leave the placeholder untouched, startup fails by design with
`manifest_path_placeholder` during admission preflight.

### Generate a signed admission manifest (one-liner)

Before this step, generate operator + manifest signer keys using:

- `docs/NODE_OPERATOR_KEYGEN_RUNBOOK.md`

Use the helper script to produce `signed-manifest.json` from a payload +
Ed25519 private key:

```bash
scripts/generate_signed_manifest.sh --payload ./manifest.payload.json --private-key ./manifest-signer-ed25519.pem --key-id "$(openssl pkey -in ./manifest-signer-ed25519.pem -pubout -outform DER | tail -c 32 | od -An -v -tx1 | tr -d ' \n')" --output ./signed-manifest.json
```

For a full technical walkthrough (payload fields, signature model, and rollout
steps), see:

- `docs/ADMISSION_MANIFEST_GENERATION_HOWTO.md`

   Operator disaster-recovery procedures (snapshot/restore drills, signed retention, quorum-safe regional restore) are documented in:

   - `docs/OPERATOR_DISASTER_RECOVERY_RUNBOOK.md`

   Observer/watcher rollout profile (read-only runtime mode, bootstrap template, and onboarding checks) is documented in:

   - `docs/OBSERVER_NODE_RUNBOOK.md`

   Builder-credit grant signer operations and deterministic 3-of-5 multisig proof construction are documented in:

   - `docs/MULTISIG_3_OF_5_IMPLEMENTATION_HOWTO.md`

   Credit-grant-gated write access model (API key + grant composition for sponsored user writes) is documented in:

   - `docs/CREDIT_GRANT_WRITE_GATING_MODEL.md`

   Complete on-chain policy runtime sync sample for all validator node configs is documented in:

   - `docs/ONCHAIN_POLICY_RUNTIME_SYNC_SAMPLE.md`

   Operational rollout runbook for policy sync (cohort restart, parity checks, rollback, and audit evidence) is documented in:

   - `docs/ONCHAIN_POLICY_RUNTIME_SYNC_RUNBOOK.md`

   End-to-end localnet execution runbook for real entry submission + 80% consensus finality checks + 3-of-5 multisig builder-credit grant submission is documented in:

   - `docs/LOCALNET_80_QUORUM_MULTISIG_RUNBOOK.md`

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

### Build a separated runtime + app bundle (node runtime in Docker)

If you want the compiled node runtime and companion apps outside the main
source tree, generate a standalone bundle:

```bash
scripts/package_runtime_stack.sh
```

This creates `dist/runtime-stack/` with:

- `node-runtime/bin/citizen-node` (compiled release runtime)
- `node-runtime/docker/` (Dockerfile + Compose to run the compiled runtime)
- `node-runtime/run-node.sh` (node runtime CLI wrapper)
- `apps/wallet-cli`, `apps/explorer`, `apps/dapp`, and `apps/demo` (copied
  implementation folders without build artifacts)

To run the compiled runtime from the generated bundle:

```bash
cd dist/runtime-stack/node-runtime
./run-node.sh ./config/node.toml
```

To run the compiled runtime in Docker:

```bash
cd dist/runtime-stack/node-runtime/docker
docker compose up --build
```

Admission policy note: the generated runtime bundle defaults to
`manifest_enforce = false` for local/dev convenience only. For shared, staged,
and production environments, the recommended setup is `manifest_enforce = true`
with `manifest_path` set to a signed admission manifest that is mounted or
copied into the runtime at that exact path.

You can generate a signed manifest payload and signature using the workflow in
`deploy/runtime-stack/README.md`.

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

Licensed under [Citizen Protocol Non-Commercial License (CPNCL) v1.0](LICENSE).
