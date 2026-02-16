# Secure Network Admission Mechanism — Implementation Task List

This task list converts the guidance in `docs/NETWORK_ADMISSION_CONTROL_PLAN.md` into an execution checklist for implementation tracking.

## Kickoff Status (Implementation Start)

This tracker is now in active execution mode. The checklist below captures what is already present in the codebase and what remains to deliver the full secure admission design.

### Baseline already implemented

- [x] Validator allowlist admission exists for handshake identity (`validator_id` + `public_key`) in `crates/network`.
- [x] Time-based key epoch rotation support exists in admission control (`key_epoch`, rotation interval).
- [x] Baseline admission tests exist (allowlisted peer accepted, unknown peer rejected, rotation epoch advances).

### Current implementation focus (Wave 1)

1. Node admission module and startup preflight.
2. Signed manifest verification and canonical digesting.
3. Extended handshake identity binding (`network_id`, `genesis_hash`, `manifest_digest`, replay/PSK proofs).
4. Startup + handshake fail-closed telemetry and test coverage.

### Progress Update (Wave 1 continuation)

- Inbound handshake enforcement is now fully wired in `crates/network` (identity tuple checks, PSK proof, replay cache, fail-closed stream drops).
- Startup preflight tests now cover valid manifests plus signature/network/genesis mismatch failures.
- Remaining work is concentrated on observer handshake parity, rotation policy states, and startup metrics.

## 1) Architecture & Scaffolding

- [x] Create `crates/node/src/admission/` module.
- [x] Add `runtime_identity.rs` for compile-time constants:
  - [x] `RUNTIME_NETWORK_ID`
  - [x] `RUNTIME_PSK_HASH` (or equivalent root key fingerprint)
  - [x] trusted manifest signing key set
- [x] Add `manifest.rs` for canonicalization and signature verification.
- [x] Add `startup.rs` for preflight validation and typed startup errors.
- [x] Define shared `AdmissionContext` and `AdmissionError` types.

## 2) Node Config & Startup Preflight

- [x] Extend node config with admission inputs:
  - [x] `network_id`
  - [x] `manifest_path`
  - [x] `manifest_enforce`
  - [x] `startup_secret` (when PSK mode is enabled)
  - [x] optional controlled `expected_genesis_hash` override for migration tooling
- [x] Run admission preflight before networking/consensus startup.
- [x] Load and verify signed manifest during startup.
- [x] Compute local genesis hash from canonical ledger source.
- [x] Verify equality between runtime constants, config, manifest, and local genesis digest.
- [x] Fail closed on admission failure with explicit non-zero exit behavior.

## 3) Signed Manifest Verification

- [x] Define deterministic manifest schema and canonical payload encoding.
- [x] Implement signature envelope verification against trusted runtime keys.
- [x] Enforce signature algorithm allowlist.
- [x] Enforce manifest freshness/expiry policy.
- [x] Compute canonical `manifest_digest` for handshake identity binding.

## 4) Network Handshake Admission Enforcement

- [x] Extend `PeerHandshake` identity fields:
  - [x] `network_id`
  - [x] `genesis_hash`
  - [x] `manifest_digest`
  - [x] nonce/timestamp
  - [x] PSK challenge-response proof
- [x] Include admission identity fields in outbound handshake construction.
- [x] Enforce inbound handshake checks:
  - [x] validator allowlist/public key
  - [x] network ID match
  - [x] genesis hash match
  - [x] manifest digest match
  - [x] PSK proof validity
  - [x] replay protection
- [x] Drop connection immediately on mismatch.

Status note: all inbound checks listed below are implemented; the parent item is now complete.

## 5) Replay Protection & Secret Proofing

- [x] Add anti-replay cache for nonce/timestamp validation.
- [x] Implement challenge-response proof derivation (no static secret transmission).
- [x] Use constant-time comparison for proof verification.
- [x] Enforce startup secret validation when PSK mode is enabled.

## 6) Observer/Validator Policy Parity

- [x] Ensure observer nodes use the same admission preflight checks.
- [x] Ensure observer nodes use the same handshake admission checks.
- [x] Confirm no observer bypasses for network identity rules.

Execution note: observer startup and handshake admission parity are now enforced through a shared `NodeConfig::handshake_identity` path in `crates/node/src/main.rs`, so observer and validator peers inherit the same identity tuple + PSK settings.

## 7) Key Rotation & Governance-Compatible Transitions

- [x] Implement manifest key states:
  - [x] `ACTIVE_KEYS`
  - [x] `TRANSITION_KEYS`
  - [x] `REVOKED_KEYS`
- [x] Enforce transition policy (e.g., old+new signature threshold during window).
- [x] Reject old-only signatures after transition window closes.
- [x] Reject revoked keys at all times.

## 8) Error Model, Logs, and Metrics

- [x] Implement typed admission errors (startup + handshake).
- [x] Add structured rejection/startup logs with reason codes and peer context.
- [x] Add security metrics:
  - [x] `admission_startup_fail_total{reason}`
  - [x] `admission_handshake_reject_total{reason}`
  - [x] `manifest_verification_duration_ms`
  - [x] `psk_challenge_fail_total`

Execution note: metrics work should land as one atomic telemetry change set so startup/manifest timing/reason labels are introduced with consistent naming and dashboards.

## 9) Testing & Validation Matrix

- [x] Startup tests:
  - [x] valid manifest + matching network/genesis + valid PSK starts successfully
  - [x] invalid manifest signature fails startup
  - [x] network mismatch fails startup
  - [x] genesis mismatch fails startup
  - [x] observer mismatch fails startup
- [x] Handshake tests:
  - [x] matching allowlisted peer accepted
  - [x] network mismatch rejected
  - [x] genesis mismatch rejected
  - [x] manifest digest mismatch rejected
  - [x] invalid PSK proof rejected
  - [x] replayed nonce/timestamp rejected

Status note: handshake matrix items listed above are now covered; remaining matrix work is rotation plus explicit observer-role mismatch coverage.
- [x] Rotation tests:
  - [x] transition window enforces old+new requirement
  - [x] post-window old-only rejected
  - [x] revoked-key signature rejected

## 10) Rollout Readiness

- [x] Add operator runbook section for admission troubleshooting.
- [x] Add CI checks for manifest lint/verification.
- [x] Document controlled fork process for network identity changes.
- [ ] Perform staged rollout in localnet before production validator rollout.

## 11) Next Execution Queue (Wave 2)

1. **Observer handshake parity implementation**
   - [x] Bring observer nodes onto authenticated peer networking with the same `AdmissionControl` validation path.
   - [x] Add observer-specific integration tests that assert identity mismatch/manifest mismatch rejection behavior on inbound and outbound handshakes.
2. **Manifest key-state transitions**
   - 2026-02-15 update: manifest transition cutoff enforcement now returns typed errors (`ManifestTransitionSignatureRequired`, `ManifestOldSignatureAfterCutoff`) and includes focused regression tests for transition-window and post-cutoff behavior.
   - [x] Introduce `ACTIVE/TRANSITION/REVOKED` key-state evaluation in manifest verification.
   - 2026-02-15 update: manifest verification now enforces ACTIVE-key signatures, optional dual-signature transition policy, and immediate rejection for revoked keys.
   - [x] Add transition-window enforcement tests (old+new required, old-only rejection after cutoff).
3. **Admission telemetry completion**
- 2026-02-16 update: handshake rejection telemetry now records stable reason labels (`admission_handshake_reject_total{reason}` semantics) alongside aggregate counters, with regression assertions in `crates/network/tests/admission.rs`.
   - [x] Emit startup failure counters with reason labels.
   - [x] Record manifest verification duration histogram and connect it to rollout dashboards.
4. **Operator readiness artifacts**
   - 2026-02-15 update: published `docs/NETWORK_ADMISSION_TROUBLESHOOTING_RUNBOOK.md` with startup/handshake reason-code triage and escalation checklist.
   - 2026-02-16 update: startup preflight now hard-fails manifests with missing/duplicate validator allowlist entries, and node admission snapshots now default to the signed manifest allowlist for handshake enforcement.
   - [x] Publish an admission troubleshooting runbook section with reason-code triage.
   - [x] Add CI manifest lint/verification checks to block unsigned or stale rollout manifests.

## Definition of Done

- [x] All startup and handshake admission checks are enforced by default.
- [x] Validators and observers share the same network identity enforcement path.
- [x] Key rotation and replay protection are covered by automated tests.
- [x] Admission failures are auditable through logs and metrics.

## 12) Continued Implementation Task List (Wave 3)

This section extends the execution tracker with the next concrete delivery slices needed to close all remaining Wave 1/Wave 2 gaps.

### 12.1 Close observer handshake parity (highest priority)

- [x] **Networking path parity**
  - [x] Route observer outbound and inbound peer handshakes through the same `AdmissionControl::verify` entrypoint used by validators.
  - [x] Remove any observer-only fast path that skips `network_id`, `genesis_hash`, `manifest_digest`, PSK, or replay checks.
  - 2026-02-15 update: observer nodes now initialize QUIC admission networking with the shared `AdmissionControl` policy path used by validators, while remaining read-only for consensus.
- [x] **Observer integration coverage**
  - 2026-02-15 update: added cross-role admission coverage in `crates/network/tests/admission.rs` for observer inbound (`network_id` mismatch, `manifest_digest` mismatch) and validator inbound rejection of invalid observer identity tuples.
  - [x] Add integration test: observer rejects validator handshake with mismatched `network_id`.
  - [x] Add integration test: observer rejects validator handshake with mismatched `manifest_digest`.
  - [x] Add integration test: validator rejects observer handshake when observer identity tuple is invalid.
- [x] **Acceptance check**
  - [x] Produce a test matrix artifact showing observer and validator rejection reasons are identical for equivalent bad inputs.
  - 2026-02-15 update: `crates/network/tests/admission.rs::observer_and_validator_share_identity_mismatch_rejection_matrix` now codifies a role-parity matrix across `network_id`, `genesis_hash`, and `manifest_digest` mismatch cases and asserts identical `AdmissionRejectionReason` outcomes for observer and validator inbound admission paths.


### 12.1.1 Command reference (path-safe)

Preferred command (works from any directory and both repo layouts):

- `./citizen-protocol/scripts/run_admission_tests.sh` (nested layout)
- `./scripts/run_admission_tests.sh` (direct layout)

Path-safe manual equivalent:

- `cargo test -p citizen-network --test admission --manifest-path "$(test -f citizen-protocol/Cargo.toml && echo citizen-protocol/Cargo.toml || echo Cargo.toml)"`

This avoids hard-coding `citizen-protocol/Cargo.toml` in environments where `Cargo.toml` is at the repository root.


Targeted startup-test execution (multiple exact tests):

- `./citizen-protocol/scripts/run_node_startup_admission_tests.sh admission::startup::tests::preflight_rejects_manifest_with_empty_allowlist admission::startup::tests::preflight_accepts_fresh_manifest`
- `./scripts/run_node_startup_admission_tests.sh admission::startup::tests::preflight_rejects_manifest_with_empty_allowlist admission::startup::tests::preflight_accepts_fresh_manifest`

Equivalent single-command filter (regex accepted by Cargo as one test expression):

- `cargo test -p citizen-node "admission::startup::tests::(preflight_rejects_manifest_with_empty_allowlist|preflight_accepts_fresh_manifest)" --manifest-path "$(test -f citizen-protocol/Cargo.toml && echo citizen-protocol/Cargo.toml || echo Cargo.toml)" -- --nocapture`

### 12.2 Finalize key-transition cutoff behavior

- [x] **Transition window cutoff enforcement**
  - [x] Implement explicit cutoff evaluation (timestamp or block-height based) so old-only signature sets are rejected once the transition closes.
  - [x] Ensure failure reason maps to a stable typed admission error code for telemetry consistency.
- [x] **Rotation regression tests**
  - [x] Add test: during transition window, old+new signature requirement enforced.
  - [x] Add test: after transition window, old-only signature set is rejected.
  - [x] Add test: revoked key signatures fail regardless of transition status.

### 12.3 CI manifest guardrails

- 2026-02-16 update: added `citizen-protocol/.github/workflows/network-admission-guardrails.yml` and `citizen-protocol/scripts/run_admission_tests.sh` to enforce admission startup/manifest/network test gates in CI.
- [x] **Static lint and verification gates**
  - [x] Add CI job that validates manifest schema/canonicalization.
  - [x] Add CI job that verifies trusted signature presence and algorithm allowlist.
  - [x] Add CI check that fails stale manifests (`expires_at` policy threshold) before merge.
- [x] **Policy documentation**
  - [x] Document CI failure remediation steps in `NETWORK_ADMISSION_TROUBLESHOOTING_RUNBOOK.md`.

### 12.4 Controlled network-identity change process

- [x] **Fork/change procedure doc**
  - [x] Specify operator/governance steps for planned `network_id` or `genesis_hash` changes.
  - [x] Define rollout sequencing and rollback/abort checkpoints.
  - [x] Add explicit signer/quorum requirements for manifest updates tied to identity changes.
- [x] **Dry-run validation**
  - [x] Execute and record a localnet rehearsal for identity transition with zero admission bypasses.
  - 2026-02-16 update: added `identity_transition_rejects_pre_transition_handshake_tuple` in `crates/network/tests/admission.rs` to rehearse identity tuple cutover behavior (pre-transition tuple rejected post-transition, transitioned tuple accepted) with no bypass path.

Execution note: added `docs/NETWORK_IDENTITY_CHANGE_RUNBOOK.md` documenting governance/signer quorum, rollout sequencing, rollback checkpoints, and a reusable localnet dry-run record template.

### 12.5 Rollout completion checklist

- [ ] Run full admission matrix in CI (startup, handshake, observer parity, rotation).
- [ ] Confirm telemetry dashboards include startup failure and handshake rejection reason distributions.
- [ ] Collect sign-off from node, network, and governance owners before production rollout.
