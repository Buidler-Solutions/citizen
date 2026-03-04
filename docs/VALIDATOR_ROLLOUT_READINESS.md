# Validator Rollout Readiness Gate

This runbook defines the post-phase validator rollout readiness confirmation that
must be completed before adding operators to futurenet/mainnet cohorts.

## Scope

Use this gate for every validator operator onboarding wave.

Readiness is confirmed only when all four workstreams are complete:

1. Key custody + rotation evidence.
2. Peer admission policy evidence.
3. Telemetry/alerting evidence.
4. Operator runbook completion evidence.

## Required Inputs

- Governance-approved operator roster (institution + validator DID).
- Signed validator manifest (`testnets/futurenet.toml` or `testnets/mainnet.toml`).
- Candidate node config package (per-operator `node.toml`).
- Latest disaster-recovery drill report (`docs/OPERATOR_DISASTER_RECOVERY_RUNBOOK.md`).
- Latest simulation release-gate artifact (`reports/releases/*.json`).

## Gate A — Keys & Identity Anchors

Each candidate validator must provide:

- Validator ID and institutional/legal identity anchor(s).
- Long-term signing key provenance (HSM/TPM-backed or equivalent attestation).
- Network key rotation policy (`network_key_rotation_secs`) aligned to governance defaults.
- Proof private keys are not shared across validator/observer roles.

Pass criteria:

- Manifest includes validator entry with non-placeholder `public_key`.
- At least one identity anchor is recorded per validator.
- Key custody and rotation evidence is archived in operator sign-off packet.

## Gate B — Peer Admission Policy

Each validator config must enforce an allowlist from the governance-approved
validator snapshot.

Validation checklist:

- `[[validators]]` includes only governance-approved peers.
- Governance manifest allowlist is non-empty and sized for active+standby operation
  (target: 200% of active consensus seats).
- Runtime split is deterministic: `ActiveSize = ceil(N/2)`, `StandbySize = N - ActiveSize`.
- Unknown peers are denied at authenticated handshake.
- `quorum_bps` remains `8000` unless explicitly changed by governance proposal,
  and is applied to the active set only (`ceil(0.8 * |V_active|)`).
- Epoch rotation controls are configured and reviewed: `epoch_length_blocks`
  and `promotion_limit`.
- API write edge controls are configured (`api_auth_required = true`, scoped API keys, rate limits).

Pass criteria:

- Admission policy replay test confirms only allowlisted peers connect.
- Rotation dry-run confirms deterministic promotion from standby at epoch
  boundary with identical active/standby results on all sampled nodes.
- Config diff review against approved manifest has no unauthorized validators.
- Write endpoint authz scopes are documented for operational clients.

## Gate C — Telemetry & Alerting

Each operator must publish the following telemetry minimums:

- Node liveness (`/health` uptime probe).
- Consensus participation (pre-vote/commit activity, stalled round alerting).
- API protection signals (`401`/`403`/`429` rates on write endpoints).
- Storage safety (RocksDB size growth and snapshot success/failure).

Operational expectations:

- Logs exported with `RUST_LOG=info` or stricter profile.
- Alert routing configured for 24x7 operator ownership.
- Weekly telemetry review for quorum-risk indicators (availability drop,
  rising round aborts, sustained admission failures).

Pass criteria:

- Operator demonstrates dashboards or equivalent query outputs for all required metrics.
- Alert test (synthetic failure) reaches on-call channel.

## Gate D — Runbook Completion

Each operator must execute and attest to these runbooks:

- `docs/LOCALNET_RUNBOOK.md` (bootstrap and config adaptation).
- `docs/OPERATOR_DISASTER_RECOVERY_RUNBOOK.md` (snapshot/restore drill).
- `docs/OBSERVER_NODE_RUNBOOK.md` (role separation validation for paired observers).
- `docs/NETWORK_ADMISSION_TROUBLESHOOTING_RUNBOOK.md` (startup/handshake admission reason-code triage).

Pass criteria:

- At least one successful restore drill in the current release cycle.
- Signed acknowledgement of role boundaries (validator vs observer duties).
- Escalation contacts and maintenance windows documented.

## Sign-off Template

Record one row per operator and archive with release evidence.

| Operator | Validator ID | Gate A Keys | Gate B Admission | Gate C Telemetry | Gate D Runbooks | Sign-off Date | Reviewer |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Institution A | did:ledger:validator:example-a | ✅ | ✅ | ✅ | ✅ | YYYY-MM-DD | governance reviewer |
| Institution B | did:ledger:validator:example-b | ✅ | ✅ | ✅ | ✅ | YYYY-MM-DD | governance reviewer |

## Release Gate Outcome

Validator rollout readiness is **approved** only when:

- 100% of candidate operators pass Gates A–D.
- Latest simulation matrix artifact exists for the release.
- Latest DR drill report includes validator and observer recovery evidence.

If any operator fails a gate, onboarding is deferred until remediation and
re-review are complete.
