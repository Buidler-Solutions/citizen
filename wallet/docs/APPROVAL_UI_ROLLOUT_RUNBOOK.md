# Wallet Approval UI Staged Rollout & Rollback Runbook

## Scope

This runbook covers staged rollout of the browser wallet dedicated dApp approval UI and the rollback path when approval flow health degrades.

- Rollout control: `VITE_WALLET_APPROVAL_UI_ROLLOUT`
- Stages: `internal` → `beta` → `general`
- Emergency rollback stage: `disabled`

## Rollout stages

1. **internal**
   - Wallet team only.
   - Validate request queueing, explicit approve/reject UX, and stale request expiry.
2. **beta**
   - Limited partner dApps and builder test cohorts.
   - Monitor approval, rejection, and timeout rates every release window.
3. **general**
   - Default stage for production wallet builds after stable beta metrics.

## Observability and thresholds

The extension exposes `wallet_getApprovalMetrics` for side-panel visibility of:

- approval rate
- rejection rate
- timeout rate
- total decided requests

The relay/direct-submit failure rate remains a cross-stack metric sourced from backend relay telemetry while Model 1 is active.

Suggested thresholds before moving to the next stage:

- Timeout rate below 5% over at least 100 decided requests.
- Rejection rate within expected dApp-specific baseline (investigate sudden spikes > 2x baseline).
- No unresolved `ERR_MALFORMED_REQUEST` or `ERR_CONCURRENT_REQUEST` regressions.

## Promotion checklist

- Confirm wallet/browser tests are passing.
- Confirm onboarding dApp integration still requires signed state before submit.
- Confirm no unresolved origin-spoofing UI bugs.
- Update release notes with the target stage and promotion timestamp.

## Rollback procedure

1. Set `VITE_WALLET_APPROVAL_UI_ROLLOUT=disabled` in the extension build environment.
2. Rebuild extension bundle and ship hotfix package.
3. Announce rollback window to internal/beta cohorts with incident ticket ID.
4. Monitor timeout-rate recovery (pending requests will expire while UI is disabled).
5. Root-cause fix and rerun wallet/browser test suite.
6. Re-enable at `internal`, then progress stage-by-stage again.

## Incident logging

For each rollback, record:

- UTC timestamp and stage rolled back from.
- Trigger metric(s) and observed values.
- Affected dApp origins.
- Fix commit SHA and retest evidence.
