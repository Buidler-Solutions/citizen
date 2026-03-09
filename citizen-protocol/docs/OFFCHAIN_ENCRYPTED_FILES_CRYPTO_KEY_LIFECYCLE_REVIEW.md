# Off-Chain Encrypted Files — Cryptography + Key Lifecycle Review

Status: ✅ Approved for `offchain_encrypted_files_v1` gated rollout

Date: 2026-03-08

Owners: Protocol Security, Wallet, API Operations

Related:
- `docs/OFFCHAIN_ENCRYPTED_FILES_IMPLEMENTATION_PLAN.md`
- `docs/OFFCHAIN_ENCRYPTED_FILES_CREDENTIAL_CUSTODY_RUNBOOK.md`
- `docs/OFFCHAIN_ENCRYPTED_FILES_INCIDENT_RESPONSE_PLAYBOOK.md`

## 1) Review Scope

This review covers the release-gate requirement for:

- deterministic commitment construction for encrypted file manifests and encrypted payload fields,
- wallet/SDK encryption + verification behavior,
- grant-gated decrypt guarantees,
- credential/key lifecycle controls required for production operation.

## 2) Cryptography Findings

### 2.1 Deterministic commitment integrity
- Commitment generation paths are deterministic and validated by shared vectors in Rust + TypeScript runtimes.
- File-manifest and payload-field commitment derivation are stable under repeated runs with identical inputs.
- Verification path (`receipt -> payload_commitment -> ciphertext hash/object hash`) is auditable and reproducible.

### 2.2 Encryption and decryption behavior
- Streaming encryption/decryption flow avoids full-blob in-memory requirements for large objects.
- Adversarial coverage exists for tampered ciphertext reconciliation and unauthorized decrypt attempts.
- Runtime behavior is fail-closed: decrypt is denied when active grants are absent or revoked.

### 2.3 Policy and namespace controls
- Namespace field-policy enforcement prevents plaintext submission for required encrypted fields.
- Commit APIs reject missing encrypted references when namespace rules require off-chain encryption.
- Governance-managed policy versioning enforces migration before incompatible payload commits are accepted.

## 3) Key Lifecycle Findings

### 3.1 Custody and access model
- Storage/KMS credentials are required to follow least-privilege custody and dual-control handling.
- Rotation intervals, audit evidence, and compromise escalation paths are documented.
- Operator workflow includes break-glass and post-incident rekey requirements.

### 3.2 Grant and revocation lifecycle
- Reader authorization checks are grant-aware and enforce revocation before file-read approval.
- Revocation semantics preserve auditability while denying future reads.
- Alerts are emitted for revocation conflicts and commitment mismatches for operator response.

## 4) Residual Risks and Required Controls

Residual risks accepted for v1 (with controls):

1. **Policy drift risk** between namespace policy updates and client payload builders.
   - Control: enforce `policy_version`/`min_supported_policy_version` checks and migration guides.
2. **Operator key misconfiguration risk** in multi-environment rollouts.
   - Control: mandatory runbook validation and evidence capture per environment gate.
3. **Replay/abuse pressure on file flows**.
   - Control: idempotency semantics, rate limits, and access alerting in API layer.

## 5) Review Decision

Decision: **APPROVED WITH GATE CONTROLS**.

Release condition for production enablement remains:
- `offchain_encrypted_files_v1` must stay default OFF until the production readiness report is published and signed.

Sign-off:
- Protocol Security: ✅
- Wallet Maintainers: ✅
- API Operations: ✅
