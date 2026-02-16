# Active/Standby Architecture Double-Check (Suggestion Audit)

## Scope

This review compares the requested “200% allowlist active/standby” suggestion against
what is currently implemented in the repository.

## Verdict

The architecture is **substantially implemented**, including:

- Active/standby validator statuses and metadata.
- Deterministic active/standby split at boot (`ceil(N/2)` active).
- Quorum based on active validators only.
- Epoch-based rotations with promotion limits.
- Standby-only node runtime mode.
- Admission enforcement of non-empty allowlist manifests.
- Simulation scenarios for 10% / 15% / 30% active-failure patterns.

However, a few items are still **partial or not fully aligned** with the suggestion.

## Requirement-by-requirement status

| Suggestion item | Status | Evidence / Notes |
| --- | --- | --- |
| Extend validator metadata with Active/Standby/Suspended + performance stats | ✅ Implemented | `ValidatorMetadata` includes `status` and `performance`; `ValidatorStatus` has `Active`, `Standby`, `Suspended`; `ValidatorPerformance` includes `uptime_bps` and `missed_prevotes`. |
| Extend snapshot with epoch state and pending replacements | ✅ Implemented | `ValidatorSetSnapshot` includes `epoch_state`; `EpochState` tracks `epoch`, `epoch_length_blocks`, `promotion_limit`, `pending_replacements`, `last_seed`. |
| Split allowlist into active + standby on boot (`ActiveSize = ceil(N/2)`) | ✅ Implemented | Node bootstrap/build logic computes `active_size = len.div_ceil(2)` and marks remainder `Standby`. |
| Quorum computed from active validators only | ✅ Implemented | Consensus quorum uses `quorum_threshold(active_validator_ids.len(), quorum_bps)`. |
| Skip standby/suspended for proposers and pre-votes | ✅ Implemented | Proposal and pre-vote validation reject non-`Active` validators. |
| Epoch-boundary deterministic rotation | ✅ Implemented | Rotation runs only when `height % epoch_length_blocks == 0`; standby promotion ordering derived from deterministic BLAKE3-based seed material. |
| Promotion rate limiting per epoch | ✅ Implemented | Failed validator list is truncated by `epoch_state.promotion_limit`. |
| Add `RotateValidators` governance action | ✅ Implemented | `GovernanceAction::RotateValidators(ValidatorRotation)` exists and is handled by consensus. |
| Add config knobs for epoch length / promotion limit | ✅ Implemented | `ConsensusConfig` and `NodeConfig` expose `epoch_length_blocks` and `promotion_limit`. |
| Standby-only runtime flag | ✅ Implemented | `standby_only` in node config disables consensus participation. |
| Manifest allowlist required / unknown peer denial | ✅ Implemented | Startup admission returns `ManifestAllowlistRequired` when enforced manifest has empty allowlist; admission control continues to reject unknown peers at handshake. |
| Simulation scenarios for 10%, 15%, 30% active failures | ✅ Implemented | Simulation defines and executes `ActiveFailure10`, `ActiveFailure15`, `ActiveFailure30`. |
| Deterministic seed includes `manifest_digest` | ✅ Implemented | Epoch seed now includes block hash + epoch + validator count + manifest digest from snapshot state. |
| Mid-epoch failure queue populated ahead of epoch boundary | ⚠️ Partial | Liveness tracking exists, but pending replacements are materialized during epoch rotation instead of explicit mid-epoch queueing from a dedicated monitor task + telemetry endpoint integration. |
| Rotation change recorded as a block transaction/header commitment and applied strictly at `h+1` | ⚠️ Partial | Rotation is handled through a governance proposal broadcast + local snapshot update path; there is no explicit dedicated block transaction type committed in block payload/header for validator rotation. |
| Governance-driven runtime updates for new consensus params | ✅ Implemented | `GovernanceAction::UpdateParameter` now applies runtime updates for `epoch_length_blocks`, `promotion_limit`, and `quorum_bps`, then persists the updated snapshot. |

## Recommended follow-up tasks

1. **Rotation commitment model:** add explicit rotation transaction / header commitment
   and apply set changes at strict `h+1` execution boundary.
2. **Operational liveness queue:** add dedicated monitor pipeline that queues failures
   mid-epoch and persists queue state before boundary processing.
