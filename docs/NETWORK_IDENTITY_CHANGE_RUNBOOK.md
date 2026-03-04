# Network Identity Change Runbook

This runbook defines the controlled process for changing `network_id` and/or `genesis_hash` used by secure network admission.

## Scope

Use this process for:
- planned network renames,
- genesis resets (governance-approved forks),
- coordinated manifest identity transitions.

Unplanned emergency responses should start with `NETWORK_ADMISSION_TROUBLESHOOTING_RUNBOOK.md` and then return to this flow for durable recovery.

## Governance and Signer Requirements

1. Submit governance proposal in `governance.vote` namespace for identity change intent.
2. Obtain >=80% validator approval before any rollout artifacts are generated.
3. Prepare next manifest with explicit signer set:
   - at least one `ACTIVE_KEYS` signature from the current trusted key set,
   - required transition signatures per `TRANSITION_KEYS` policy,
   - zero signatures from `REVOKED_KEYS`.
4. Record proposal ID, signer key IDs, and cutoff policy in the rollout record.

## Rollout Sequence

1. **Plan and freeze**
   - Freeze non-essential node config changes.
   - Publish change window and rollback owner assignments.
2. **Build artifacts**
   - Generate signed manifest with new identity tuple (`network_id`, `genesis_hash`).
   - Run `scripts/run_admission_tests.sh` to validate startup + handshake + rotation checks.
3. **Canary validators**
   - Roll out to a small validator subset.
   - Confirm old identity peers are rejected and new identity peers are accepted.
4. **Observer rollout**
   - Upgrade observer nodes with the same manifest and startup secret policy.
   - Verify observer/validator parity for admission rejections.
5. **Full validator rollout**
   - Complete validator deployment in batches.
   - Monitor admission rejection reason distributions for unexpected spikes.
6. **Finalize transition**
   - After transition cutoff, ensure old-only signatures are rejected.
   - Revoke retired keys and update trusted key inventory.

## Rollback / Abort Checkpoints

Abort and roll back when any checkpoint fails:
- startup preflight fails on >20% canary validators,
- handshake rejections indicate `manifest_digest` mismatch among intended peers,
- quorum stability drops below 80% availability during rollout.

Rollback steps:
1. Pause further rollout.
2. Re-apply previous signed manifest and validated config bundle.
3. Confirm admission checks recover to prior baseline.
4. File governance incident record with cause and corrective actions.

## Localnet Dry-Run Record

Before production rollout, execute and record a localnet rehearsal:

- Change ticket / proposal ID:
- Candidate identity tuple:
- Rehearsal date:
- Command log:
  - `./citizen-protocol/scripts/run_admission_tests.sh`
- Result summary:
  - startup checks:
  - handshake checks:
  - rotation checks:
  - zero bypass confirmation:
- Approvers (node/network/governance):

Keep this record in repository history with the rollout PR.
