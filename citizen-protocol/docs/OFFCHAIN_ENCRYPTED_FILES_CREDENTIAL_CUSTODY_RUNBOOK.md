# Off-Chain Encrypted Files Credential Custody Runbook

Status: ✅ Active runbook (v1)

Owners: Validator operators, security operations, governance approvers

Related docs:
- `docs/OFFCHAIN_ENCRYPTED_FILES_IMPLEMENTATION_PLAN.md`
- `docs/DEEP_RESEARCH_ARCHITECTURE_BASELINE.md`
- `docs/OFFCHAIN_ENCRYPTED_FILES_ERROR_CODES.md`

## 1) Purpose

Define operational controls for storage and key custody used by `offchain_encrypted_files_v1`, including:

- object storage credentials (local/S3-compatible adapters),
- KMS/HSM credentials used for DEK wrapping operations,
- rotation, backup, revocation, and incident handling requirements.

This runbook enforces Citizen's baseline rule: plaintext user content must remain off-chain and encrypted, with access controlled by explicit grant checks and auditable governance policy.

## 2) Credential inventory and custody classes

Maintain a living credential inventory with an owner, purpose, rotation window, and break-glass contact.

### 2.1 Required credential classes

1. **Object storage write credentials**
   - Scope: write-only upload path for encrypted blobs/manifests.
   - Constraint: namespace-prefixed paths only (`<namespace>/...`).
2. **Object storage read credentials**
   - Scope: verifier/read paths.
   - Constraint: least privilege for committed object prefixes.
3. **KMS/HSM wrap/unwrap credentials**
   - Scope: DEK wrap creation and authorized unwrap flows.
   - Constraint: access only through grant-aware application paths.
4. **Audit sink credentials**
   - Scope: immutable audit/event logging destination.
   - Constraint: append-only writer policy.

### 2.2 Separation of duties

- No single operator may both approve governance policy changes and independently rotate production KMS credentials.
- Production credential issuance requires two-person review (security + platform owner).
- Break-glass credentials must be time-bound and auto-expiring.

## 3) Storage/KMS admission checklist (new environment)

Before enabling `offchain_encrypted_files_v1` in any environment:

1. Create dedicated storage bucket/prefixes for encrypted files and encrypted payload field blobs.
2. Apply bucket policy:
   - deny public ACLs,
   - deny non-TLS transport,
   - deny writes outside namespace prefixes,
   - deny object overwrite unless explicit idempotent flow key is present.
3. Provision KMS/HSM keys for wrap operations with usage logging enabled.
4. Configure application secrets through a managed secret store (never plaintext `.env` in production).
5. Validate API policy prechecks and error-code mappings using dry-run commits.
6. Record environment admission in change log with owner + expiry for temporary credentials.

## 4) Rotation policy

### 4.1 Rotation intervals

- Storage access keys: every 30 days (or sooner after personnel role change).
- KMS client/service credentials: every 30 days.
- Break-glass credentials: max TTL 24 hours.

### 4.2 Rotation procedure

1. Create replacement credential and attach identical least-privilege policy.
2. Deploy dual-credential window (old + new) for max 2 hours.
3. Restart/reload API nodes and wallet backend services.
4. Verify end-to-end flow:
   - upload intent,
   - commit,
   - commitment verification,
   - authorized read,
   - revoked-read denial.
5. Revoke old credential and confirm rejection in audit logs.
6. File rotation evidence in operations record.

## 5) Backup and recovery

- Store credential metadata (not secret material) in encrypted config backups.
- KMS keys must use provider-native durability and recovery controls.
- Restore drills are required quarterly and must include:
  - rehydrating storage adapter config,
  - validating object hash reconciliation,
  - confirming grant-based deny behavior after revocation events.

## 6) Monitoring and alerting

Set high-signal alerts for:

- failed KMS unwrap spikes,
- storage access denied anomalies,
- reads attempted after revocation,
- commitment mismatch between manifest and object hash,
- credentials used from unexpected network/location.

Escalation target: security on-call + validator operations lead.

## 7) Incident response (credential compromise)

1. **Contain**: disable suspected credential immediately.
2. **Protect**: pause affected read/write routes if compromise scope is unknown.
3. **Rotate**: issue fresh credentials and redeploy services.
4. **Invalidate**: revoke active grants where unauthorized reads are suspected.
5. **Verify**: run receipt-to-commitment hash reconciliation for impacted time window.
6. **Report**: publish incident summary and governance follow-up actions.

## 8) Audit evidence requirements

For every rotation or incident, retain:

- who approved and executed the action,
- exact credential class and environment,
- timestamps and resulting credential IDs,
- verification command outputs (commit/read/revoke checks),
- post-change confirmation that no plaintext was exposed in logs.

Retention: minimum 1 year or longer per governance policy.

## 9) Minimum operator commands/checks

Run and archive these checks after any credential change:

- `cargo test -p citizen-api offchain_encrypted_files`
- `cargo test -p citizen-wallet offchain`
- `pnpm --dir sdk/nodejs test -- offchain`

If a command is unavailable in the environment, document the limitation and run equivalent CI jobs before production rollout.
