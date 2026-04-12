# Indexer Metrics Rollout Completion and On-Call Runbook

Status: staged rollout plan + operator ownership for explorer indexer metrics.
Last updated: 2026-04-12.

## 1) Rollout stages

### Stage A — Localnet

Scope:
- Single-operator or dev laptop topology.
- Explorer backend with `INDEXER_METRICS_DEPLOYMENT_PROFILE=localnet`.

Required gate:
1. `GET /metrics/summary` returns a healthy payload with `deployment.profile=localnet`.
2. `lag.ingestion_lag_blocks` remains below local target (<= 5 in steady state).
3. `alerts` contains no active `critical` items for at least 15 minutes.

Default policy in this stage:
- metrics auth disabled by default,
- rate limit disabled by default.

### Stage B — Shared dev/test

Scope:
- Team-shared environment used by multiple builders/operators.
- Explorer backend with `INDEXER_METRICS_DEPLOYMENT_PROFILE=shared-dev`.

Required gate:
1. Metrics API key auth enabled (`metrics_auth_required=true`).
2. Rate limiting active (`metrics_rate_limit_rpm=120` by default unless explicitly overridden).
3. Backfill + verification endpoints produce reproducible outputs:
   - `POST /metrics/backfill`,
   - `GET /metrics/verify/samples`,
   - `GET /metrics/verify/tps`,
   - `GET /metrics/verify/evidence`.

### Stage C — Production candidate

Scope:
- Pre-production environment that mirrors production topology and traffic patterns.
- Explorer backend with `INDEXER_METRICS_DEPLOYMENT_PROFILE=production-candidate`.

Required gate:
1. Metrics API key auth enabled and key rotation rehearsal completed.
2. Rate limit defaults to `60` rpm per subject unless stricter override is configured.
3. Alert routing tested for all three alert classes:
   - `stalled_cursor`,
   - `sustained_lag`,
   - `checksum_mismatch`.
4. Rollback path validated by forcing fallback mode in explorer frontend (`NEXT_PUBLIC_METRICS_SOURCE=fallback`).

## 2) Operator responsibilities

Primary owner: explorer/indexer operator.

Responsibilities:
- Keep indexer worker running and verify cursor progression.
- Monitor summary SLO checks and active alerts.
- Respond to poison-block and continuity failures using the included playbook entries.
- Keep `INDEXER_METRICS_API_KEY` managed in environment-specific secret custody.
- Re-run verification endpoints after major runtime upgrades or backfills.

Secondary owner: protocol operations on-call.

Responsibilities:
- Coordinate incident response if indexer lag or checksum mismatch is sustained.
- Approve environment-level changes to auth/rate-limit defaults.
- Ensure explorer fallback mode remains functional when indexer metrics are degraded.

## 3) On-call procedures

1. **Triage freshness and availability**
   - Query `GET /metrics/summary` and inspect `lag`, `slo`, and `alerts`.
2. **Classify incident severity**
   - Any active `critical` alert => page protocol ops lead.
3. **Containment**
   - If metrics API is unstable, set frontend mode to fallback (`NEXT_PUBLIC_METRICS_SOURCE=fallback`) and announce degraded analytics mode.
4. **Recovery**
   - Run `POST /metrics/backfill` for the affected range.
   - Re-run `GET /metrics/verify/samples` and `GET /metrics/verify/tps`.
5. **Close-out evidence**
   - Capture `GET /metrics/verify/evidence` output and archive with incident timeline.

## 4) Release-notes checklist (indexer metrics)

For each release train touching indexer metrics:
- Record deployment profile used in each environment.
- Record auth/rate-limit policy deltas.
- Record verification evidence checksum snapshots.
- Record any fallback activation windows and root cause.

This checklist should be included in PR/release notes for indexer-metrics changes.
