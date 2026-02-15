# Secure Network Admission Mechanism — Implementation Task List

This task list converts the guidance in `docs/NETWORK_ADMISSION_CONTROL_PLAN.md` into an execution checklist for implementation tracking.

## 1) Architecture & Scaffolding

- [ ] Create `crates/node/src/admission/` module.
- [ ] Add `runtime_identity.rs` for compile-time constants:
  - [ ] `RUNTIME_NETWORK_ID`
  - [ ] `RUNTIME_PSK_HASH` (or equivalent root key fingerprint)
  - [ ] trusted manifest signing key set
- [ ] Add `manifest.rs` for canonicalization and signature verification.
- [ ] Add `startup.rs` for preflight validation and typed startup errors.
- [ ] Define shared `AdmissionContext` and `AdmissionError` types.

## 2) Node Config & Startup Preflight

- [ ] Extend node config with admission inputs:
  - [ ] `network_id`
  - [ ] `manifest_path`
  - [ ] `manifest_enforce`
  - [ ] `startup_secret` (when PSK mode is enabled)
  - [ ] optional controlled `expected_genesis_hash` override for migration tooling
- [ ] Run admission preflight before networking/consensus startup.
- [ ] Load and verify signed manifest during startup.
- [ ] Compute local genesis hash from canonical ledger source.
- [ ] Verify equality between runtime constants, config, manifest, and local genesis digest.
- [ ] Fail closed on admission failure with explicit non-zero exit behavior.

## 3) Signed Manifest Verification

- [ ] Define deterministic manifest schema and canonical payload encoding.
- [ ] Implement signature envelope verification against trusted runtime keys.
- [ ] Enforce signature algorithm allowlist.
- [ ] Enforce manifest freshness/expiry policy.
- [ ] Compute canonical `manifest_digest` for handshake identity binding.

## 4) Network Handshake Admission Enforcement

- [ ] Extend `PeerHandshake` identity fields:
  - [ ] `network_id`
  - [ ] `genesis_hash`
  - [ ] `manifest_digest`
  - [ ] nonce/timestamp
  - [ ] PSK challenge-response proof
- [ ] Include admission identity fields in outbound handshake construction.
- [ ] Enforce inbound handshake checks:
  - [ ] validator allowlist/public key
  - [ ] network ID match
  - [ ] genesis hash match
  - [ ] manifest digest match
  - [ ] PSK proof validity
  - [ ] replay protection
- [ ] Drop connection immediately on mismatch.

## 5) Replay Protection & Secret Proofing

- [ ] Add anti-replay cache for nonce/timestamp validation.
- [ ] Implement challenge-response proof derivation (no static secret transmission).
- [ ] Use constant-time comparison for proof verification.
- [ ] Enforce startup secret validation when PSK mode is enabled.

## 6) Observer/Validator Policy Parity

- [ ] Ensure observer nodes use the same admission preflight checks.
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
  - [ ] invalid manifest signature fails startup
  - [ ] network mismatch fails startup
  - [ ] genesis mismatch fails startup
  - [ ] observer mismatch fails startup
- [ ] Handshake tests:
  - [ ] matching allowlisted peer accepted
  - [ ] network mismatch rejected
  - [ ] genesis mismatch rejected
  - [ ] manifest digest mismatch rejected
  - [ ] invalid PSK proof rejected
  - [ ] replayed nonce/timestamp rejected
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
