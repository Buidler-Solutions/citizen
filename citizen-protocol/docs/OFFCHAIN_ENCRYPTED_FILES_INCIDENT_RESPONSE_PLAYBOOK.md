# Off-Chain Encrypted Files Incident Response Playbook

Status: ✅ Active playbook (v1)

Owners: Security operations, validator operators, governance responders

Related docs:
- `docs/OFFCHAIN_ENCRYPTED_FILES_IMPLEMENTATION_PLAN.md`
- `docs/OFFCHAIN_ENCRYPTED_FILES_CREDENTIAL_CUSTODY_RUNBOOK.md`
- `docs/OFFCHAIN_ENCRYPTED_FILES_ERROR_CODES.md`
- `docs/DEEP_RESEARCH_ARCHITECTURE_BASELINE.md`

## 1) Purpose

Define the mandatory incident response process for `offchain_encrypted_files_v1` security events involving:

- unauthorized or suspicious read attempts,
- storage credential compromise,
- KMS/HSM key-wrap compromise,
- ciphertext/commitment mismatches,
- revocation enforcement failures.

This playbook exists to preserve Citizen's core guarantees: encrypted off-chain custody, grant-gated decryption, deterministic commitment verification, and auditable governance actions.

## 2) Incident severities

### Sev 1 (Critical)

Any confirmed plaintext exposure, key compromise with active exploitability, or systemic revocation bypass.

Required response:
- immediate containment,
- emergency governance notification,
- read/write route restriction as needed,
- mandatory post-incident governance report.

### Sev 2 (High)

No confirmed plaintext leak, but credible evidence of unauthorized access attempts or cryptographic policy bypass attempts.

Required response:
- rapid triage within 30 minutes,
- targeted route controls,
- credential/key rotation where applicable,
- expanded audit reconciliation window.

### Sev 3 (Medium)

Integrity/availability issues without direct confidentiality impact (for example, persistent commitment mismatch caused by adapter drift).

Required response:
- triage within 4 hours,
- corrective action and verification rerun,
- documented remediation ticket.

## 3) Detection signals and triggers

Treat these as incident triggers unless proven benign:

1. repeated `CONSENT_REQUIRED` / `UNAUTHORIZED_READER` failures from unusual sources,
2. spikes in `COMMITMENT_MISMATCH` verification outcomes,
3. reads succeeding after a valid `ENCRYPTED_FILE_REVOKE` event,
4. KMS unwrap usage from unexpected network/location,
5. object store access with nonstandard prefixes or policy violations,
6. divergence between ledger receipts and stored blob hashes for the same manifest.

## 4) Roles and responsibilities

- **Incident Commander (IC):** coordinates scope, status, and decision logs.
- **Security Lead:** owns containment, evidence integrity, and compromise assessment.
- **Platform/Validator Ops Lead:** executes route controls, rotations, and service rollouts.
- **Protocol/Governance Liaison:** prepares governance actions (pause, validator vote, policy update).
- **Communications Owner:** handles internal/external notices after legal/governance review.

No single person may approve and execute all emergency actions alone.

## 5) Response workflow

### 5.1 Triage (first 30 minutes)

1. Open incident channel and assign IC.
2. Record initial signal source, timestamp, and suspected scope.
3. Classify severity (Sev1/Sev2/Sev3).
4. Preserve logs/events immediately (do not overwrite rolling buffers).
5. Start a time-bounded decision log.

### 5.2 Containment

Apply minimum necessary controls based on scope:

- disable compromised storage/KMS credentials,
- restrict `/api/v1/files/read` and `/api/v1/files/commit` for impacted namespaces,
- temporarily force read-only verification mode,
- if consensus integrity is at risk, initiate emergency governance pause workflow.

### 5.3 Eradication and recovery

1. Rotate affected credentials/keys using custody runbook procedures.
2. Re-deploy API and dependent services with new secrets.
3. Re-issue or revoke grants where unauthorized access may have occurred.
4. Reconcile all impacted manifests:
   - `receipt_id -> payload_commitment -> ciphertext_hash -> object hash`.
5. Validate revocation enforcement with explicit deny tests.
6. Re-enable routes incrementally with heightened alerting.

### 5.4 Post-incident closure

1. Publish internal root-cause summary within 24 hours.
2. File governance follow-up actions (parameter changes, policy updates, validator actions if needed).
3. Open corrective implementation tickets with owners and due dates.
4. Archive complete evidence packet.

## 6) Required forensic evidence

For every incident, collect and retain:

- affected namespaces, manifest IDs, receipt IDs, and object refs,
- relevant API error-code distributions and request IDs,
- credential/key IDs rotated or revoked,
- timeline of containment actions and approvals,
- verification outputs proving restored commitment correctness,
- proof that no plaintext or key material was logged.

Minimum retention: 1 year or governance-mandated longer period.

## 7) Governance escalation matrix

Escalate to governance immediately when any of the following are true:

- Sev1 incident,
- evidence of coordinated validator/operator abuse,
- proposed temporary quorum or policy changes,
- required emergency pause/resume decision,
- suspected protocol-level cryptographic flaw.

Escalation artifact must include scope, current risk, proposed action, and rollback criteria.

## 8) Validation commands after recovery

Run and archive command outputs after containment/recovery:

- `cargo test -p citizen-api offchain_encrypted_files`
- `cargo test -p citizen-wallet offchain`
- `pnpm --dir sdk/nodejs test -- offchain`

If unavailable locally, capture CI job URLs and outcomes before production re-enable.

## 9) Readiness drills

Run tabletop exercises at least quarterly covering:

1. storage credential compromise,
2. unauthorized reader attempts with stale grants,
3. commitment mismatch outbreak,
4. revocation bypass regression.

Each drill must produce:
- measured detection-to-containment time,
- documented gaps,
- assigned remediation actions.
