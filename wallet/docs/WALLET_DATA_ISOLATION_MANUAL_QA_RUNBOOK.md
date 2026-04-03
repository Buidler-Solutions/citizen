# Wallet Data Isolation Manual QA Runbook (D2)

Date: 2026-04-03  
Status: Active

This runbook closes the checklist D2 manual scenarios in `WALLET_DATA_ISOLATION_IMPLEMENTATION_CHECKLIST.md`.

## Preconditions

- Wallet browser extension built from current `wallet/browser`.
- Onboarding dApp (`landing-page/frontend`) connected to backend (`landing-page/backend`).
- Backend relay URL configured for at least one scenario.

## Scenario 1 — Unknown origin request

1. Open a non-allowlisted origin and trigger `ctzn_signCitizenTx`.
2. Confirm wallet shows full origin in Pending Request view.
3. Confirm risk flags include unknown origin context.
4. Attempt approval.

Expected:

- Wallet blocks request with deterministic permission/origin error (`ERR_ORIGIN_BLOCKED` when blocked, or request remains user-mediated when merely unknown).
- No signing artifact is returned silently.

## Scenario 2 — Payload mismatch between preview and signed bytes

1. Trigger a signing request from onboarding UI.
2. Capture payload preview/hash in wallet approval screen.
3. Tamper dApp payload before backend submit (devtools mutation of JSON body).
4. Submit signed payload.

Expected:

- Backend rejects with signature/hash mismatch validation error.
- Relay attempt is not executed for mismatched payload.

## Scenario 3 — Popup close/reopen mid-request

1. Trigger `ctzn_signCitizenTx` and keep request in `pending` state.
2. Close wallet popup/side-panel without approving.
3. Reopen wallet UI.

Expected:

- Pending request is still present with same `requestId`.
- Approve/reject actions remain idempotent.
- No duplicate signing for same request scope.

## Scenario 4 — Network outage during submission/relay

1. Complete signing flow to obtain signed artifact.
2. Disable network (or point relay endpoint to unavailable host).
3. Submit onboarding payload.

Expected:

- Backend returns deterministic submit/relay failure.
- Retry/dedup strategy preserves idempotency key behavior.
- Telemetry increments relay failure counters.

## Evidence capture

For each scenario, attach:

- UTC timestamp
- requestId (when applicable)
- dApp origin
- wallet error code or success result
- backend response status/body
- relay telemetry snapshot

Store evidence with release artifacts for staged rollout review.
