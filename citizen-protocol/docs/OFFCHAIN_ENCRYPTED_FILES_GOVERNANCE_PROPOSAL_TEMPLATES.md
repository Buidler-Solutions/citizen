# Off-Chain Encrypted Files Governance Proposal Templates

Status: ✅ Active templates (v1)

Owners: Governance facilitators, namespace stewards, validator operators

Related docs:
- `docs/OFFCHAIN_ENCRYPTED_FILES_IMPLEMENTATION_PLAN.md`
- `docs/NAMESPACE_BUILDER_GUIDE.md`
- `docs/OFFCHAIN_ENCRYPTED_FILES_ERROR_CODES.md`
- `docs/OFFCHAIN_ENCRYPTED_FILES_CREDENTIAL_CUSTODY_RUNBOOK.md`
- `docs/OFFCHAIN_ENCRYPTED_FILES_INCIDENT_RESPONSE_PLAYBOOK.md`

## 1) Purpose

Provide canonical governance proposal templates for changing encrypted-file policy without introducing ad-hoc, non-auditable edits.

These templates cover:
- namespace file-policy updates (`offchain_encrypted_file_policy`),
- namespace payload-field policy updates (`offchain_encrypted_payload_field_policy`),
- emergency parameter changes for risk containment,
- release and migration evidence requirements.

## 2) Required proposal metadata (all templates)

Every proposal should include the following metadata in `payload.change_control`:

```json
{
  "change_ticket": "GOV-CHANGE-2026-0042",
  "requested_by": "did:ledger:operator:policy-team",
  "risk_level": "medium",
  "effective_height": 128400,
  "rollback_plan_ref": "docs/runbooks/offchain-policy-rollback-v2",
  "reviewers": [
    "did:ledger:validator:alpha",
    "did:ledger:validator:beta"
  ]
}
```

Governance submissions SHOULD include deterministic references to test evidence:
- CI run URL/artifact for vector + compatibility checks,
- migration guide reference for wallet/SDK teams,
- operator runbook update link if credential or key handling is affected.

## 3) Template A — Update namespace encrypted-file action policy

Use this when changing allowed encrypted-file actions, max file size, encryption modes, or consent policy binding.

```json
{
  "proposal_id": "GOV-OFFCHAIN-FILE-POLICY-0001",
  "proposal_type": "UpdateNamespace",
  "author": "did:ledger:validator:alpha",
  "payload": {
    "namespace": "registry.land",
    "rules_patch": {
      "name": "offchain_encrypted_file_policy",
      "config": {
        "enabled": true,
        "allowed_actions": [
          "ENCRYPTED_FILE_UPLOAD",
          "ENCRYPTED_FILE_SHARE",
          "ENCRYPTED_FILE_REVOKE"
        ],
        "max_file_size_bytes": 104857600,
        "allowed_encryption_modes": [
          "passphrase_file",
          "hybrid_file_acl_dek"
        ],
        "required_consent_policy_ref": "consent.policy.encrypted-files.v2"
      }
    },
    "change_control": {
      "change_ticket": "GOV-CHANGE-2026-0042",
      "risk_level": "medium",
      "effective_height": 128400,
      "rollback_plan_ref": "docs/runbooks/offchain-policy-rollback-v2"
    },
    "evidence": {
      "compatibility_report_ref": "artifacts/offchain-policy-compat-v2.json",
      "security_review_ref": "docs/reviews/offchain-file-policy-v2.md"
    }
  },
  "voting_period_secs": 1209600
}
```

Pre-merge checks:
1. Ensure `allowed_actions` aligns with namespace business requirements.
2. Ensure `required_consent_policy_ref` resolves to an active consent policy.
3. Ensure API rejection behavior maps to documented error codes.

## 4) Template B — Update namespace encrypted payload field policy version

Use this for adding/removing required encrypted fields and version bumps.

```json
{
  "proposal_id": "GOV-OFFCHAIN-FIELD-POLICY-0007",
  "proposal_type": "UpdateNamespace",
  "author": "did:ledger:validator:beta",
  "payload": {
    "namespace": "identity.citizen",
    "rules_patch": {
      "name": "offchain_encrypted_payload_field_policy",
      "config": {
        "policy_version": 3,
        "min_supported_policy_version": 2,
        "migration_guide_ref": "docs/policies/offchain-payload-fields-v3",
        "offchain_encrypted_fields": [
          "payload.subject.ssn",
          "payload.subject.medical_record",
          "payload.subject.biometric_template_ref"
        ]
      }
    },
    "change_control": {
      "change_ticket": "GOV-CHANGE-2026-0051",
      "risk_level": "high",
      "effective_height": 129100,
      "rollback_plan_ref": "docs/runbooks/offchain-field-policy-rollback-v3"
    },
    "evidence": {
      "vector_report_ref": "artifacts/offchain-field-vectors-v3.json",
      "wallet_sdk_migration_ack_ref": "docs/policies/offchain-payload-fields-v3#migration-checklist"
    }
  },
  "voting_period_secs": 1209600
}
```

Pre-merge checks:
1. Ensure each field path is deterministic and namespace-scoped.
2. Ensure `min_supported_policy_version` does not strand supported clients.
3. Ensure migration guidance is published before proposal execution.

## 5) Template C — Emergency containment parameter change

Use this when temporary containment is required (e.g., suspicious replay spikes, key-wrap abuse indicators).

```json
{
  "proposal_id": "GOV-OFFCHAIN-EMERGENCY-0012",
  "proposal_type": "UpdateParameter",
  "author": "did:ledger:validator:gamma",
  "payload": {
    "parameter": "offchain_encrypted_files_v1.read_pause",
    "value": true,
    "ttl_blocks": 7200,
    "reason": "Contain potential unauthorized decrypt attempts pending incident triage.",
    "change_control": {
      "change_ticket": "GOV-INC-2026-0008",
      "risk_level": "critical",
      "effective_height": 129450,
      "rollback_plan_ref": "docs/OFFCHAIN_ENCRYPTED_FILES_INCIDENT_RESPONSE_PLAYBOOK.md"
    },
    "evidence": {
      "incident_ref": "INC-2026-0008",
      "forensics_ref": "artifacts/forensics/inc-2026-0008-summary.json"
    }
  },
  "voting_period_secs": 86400
}
```

Emergency follow-up requirements:
- submit a second governance action to clear temporary flags,
- publish post-incident analysis and any permanent policy deltas,
- reconcile all affected commitment/read events in audit records.

## 6) Validator voting checklist (for proposal reviewers)

Before voting `YES`, reviewers should verify:

1. **Policy correctness**
   - rules are namespace-specific,
   - no plaintext-only path is introduced for fields designated encrypted.
2. **Determinism and compatibility**
   - vectors/fixtures are updated and reproducible,
   - client migration docs exist for version bumps.
3. **Security and operations impact**
   - key/credential handling runbooks are still valid,
   - incident response path is defined for rollback.
4. **Governance integrity**
   - proposal has complete evidence references,
   - execution/rollback heights are explicit.

## 7) Operator handoff after proposal execution

After any policy-change proposal passes:

1. Record enacted policy hash + block height in operations ledger.
2. Run post-change verification flow:
   - file intent,
   - file commit,
   - payload commit,
   - authorized read,
   - revoked read denial.
3. Archive command output + evidence refs with the governance proposal ID.
4. Notify wallet/SDK integrators when `policy_version` or consent requirements changed.
