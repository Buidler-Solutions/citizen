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
- [ ] Enforce inbound handshake checks:
  - [x] validator allowlist/public key
  - [x] network ID match
  - [x] genesis hash match
  - [x] manifest digest match
  - [x] PSK proof validity
  - [x] replay protection
- [ ] Drop connection immediately on mismatch.

## 5) Replay Protection & Secret Proofing

- [x] Add anti-replay cache for nonce/timestamp validation.
- [x] Implement challenge-response proof derivation (no static secret transmission).
- [x] Use constant-time comparison for proof verification.
- [x] Enforce startup secret validation when PSK mode is enabled.

## 6) Observer/Validator Policy Parity

- [x] Ensure observer nodes use the same admission preflight checks.
- [ ] Ensure observer nodes use the same handshake admission checks.
- [ ] Confirm no observer bypasses for network identity rules.

## 7) Key Rotation & Governance-Compatible Transitions

- [ ] Implement manifest key states:
  - [ ] `ACTIVE_KEYS`
  - [ ] `TRANSITION_KEYS`
  - [ ] `REVOKED_KEYS`
- [ ] Enforce transition policy (e.g., old+new signature threshold during window).
- [ ] Reject old-only signatures after transition window closes.
- [ ] Reject revoked keys at all times.

## 8) Error Model, Logs, and Metrics

- [ ] Implement typed admission errors (startup + handshake).
- [ ] Add structured rejection/startup logs with reason codes and peer context.
- [ ] Add security metrics:
  - [ ] `admission_startup_fail_total{reason}`
  - [ ] `admission_handshake_reject_total{reason}`
  - [ ] `manifest_verification_duration_ms`
  - [ ] `psk_challenge_fail_total`

## 9) Testing & Validation Matrix

- [ ] Startup tests:
  - [ ] valid manifest + matching network/genesis + valid PSK starts successfully
  - [x] invalid manifest signature fails startup
  - [x] network mismatch fails startup
  - [x] genesis mismatch fails startup
  - [ ] observer mismatch fails startup
- [ ] Handshake tests:
  - [x] matching allowlisted peer accepted
  - [x] network mismatch rejected
  - [x] genesis mismatch rejected
  - [x] manifest digest mismatch rejected
  - [x] invalid PSK proof rejected
  - [x] replayed nonce/timestamp rejected
- [ ] Rotation tests:
  - [ ] transition window enforces old+new requirement
  - [ ] post-window old-only rejected
  - [ ] revoked-key signature rejected

## 10) Rollout Readiness

- [ ] Add operator runbook section for admission troubleshooting.
- [ ] Add CI checks for manifest lint/verification.
- [ ] Document controlled fork process for network identity changes.
- [ ] Perform staged rollout in localnet before production validator rollout.

## Definition of Done

- [ ] All startup and handshake admission checks are enforced by default.
- [ ] Validators and observers share the same network identity enforcement path.
- [ ] Key rotation and replay protection are covered by automated tests.
- [ ] Admission failures are auditable through logs and metrics.
