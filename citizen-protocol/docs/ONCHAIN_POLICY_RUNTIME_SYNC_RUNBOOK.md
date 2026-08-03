# On-Chain Policy Runtime Sync Runbook

## Purpose

Operational runbook for rolling out governance-approved namespace policy updates
across all validator runtimes without creating validation drift.

Use this with:

- `docs/ONCHAIN_POLICY_RUNTIME_SYNC_SAMPLE.md`
- `docs/LOCALNET_BFT_QUORUM_MULTISIG_RUNBOOK.md`

## Scope

Applies to policy-bearing namespace runtime config updates, especially:

- `builder.credits` policy (`builder_credit_policy`),
- `grant_approvers`, threshold changes, and programmable grant flags,
- any namespace `rules_hash` revision that changes validation behavior.

## Roles

- **Governance operators**: approve policy changes and publish policy artifact.
- **Validator operators**: apply the exact policy package to each node runtime.
- **SRE / release coordinator**: orchestrate phased restarts and parity checks.

## Preconditions

1. Governance approval complete and recorded.
2. Canonical policy package + `rules_hash` published.
3. Maintenance window and rollback plan defined.
4. Updated runtime config prepared for each validator.

## Step-by-step Procedure

### Step 1 — Freeze write-sensitive operations

Temporarily pause non-essential write traffic that depends on the changing
namespace policy.

### Step 2 — Verify canonical policy artifact

Before touching validators, ensure all operators are using the same policy
payload and hash:

- same namespace descriptor,
- same validator rules array and order,
- same `grant_approvers` set and key material,
- same `required_grant_approvals` and limits.

### Step 3 — Patch validator runtime configs

Apply the identical namespace policy block to each validator `node.toml`.
Do **not** hand-edit values differently by node.

### Step 4 — Cohort restart

Restart validators in small cohorts (for example, 20–25% at a time):

1. drain / stop cohort,
2. apply config,
3. restart,
4. verify healthy consensus participation,
5. continue with next cohort.

### Step 5 — Runtime parity verification

For each validator, verify:

- expected `rules_hash` in loaded config,
- same namespace validator rule count and names,
- same approver IDs/public keys,
- no node reports policy mismatch warnings.

### Step 6 — Functional policy validation

Submit deterministic smoke entries against the updated namespace:

- one valid grant + sponsorship flow,
- one expected rejection path (e.g. invalid/unknown grant linkage),
- verify rejection reason consistency across nodes.

### Step 7 — Resume normal traffic

After parity and smoke checks pass, resume full write traffic.

## Rollback Procedure

If any cohort fails parity/consensus checks:

1. pause next cohort rollout,
2. revert affected cohort to last known-good config,
3. restart reverted nodes,
4. re-check consensus health,
5. open incident and compare canonical artifact vs deployed runtime files.

## Drift Detection Checklist

Use this checklist for every rollout:

- [ ] `descriptor.namespace` matches expected namespace.
- [ ] `descriptor.version` and `descriptor.rules_hash` match release artifact.
- [ ] `descriptor.governed_by` remains `governance.vote`.
- [ ] `builder_credit_policy.required_grant_approvals` identical across nodes.
- [ ] `builder_credit_policy.grant_approvers` IDs and public keys identical.
- [ ] programmable policy (`enabled`, `policy_id`, `actors`, limits) identical.

## Security Notes

- Keep approver private keys out of runtime config and repo.
- Use isolated signer services or HSM/TPM-backed custody for grant signing.
- Rotate approver keys via governance-approved policy change only.

## Evidence to Archive

For auditability, store:

- governance approval reference,
- canonical policy artifact and hash,
- per-validator config checksum before/after,
- rollout timestamps by cohort,
- smoke test requests/responses and resulting ledger receipts.
