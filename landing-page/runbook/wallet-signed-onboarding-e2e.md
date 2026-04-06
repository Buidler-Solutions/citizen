# Wallet-Signed Onboarding E2E Validation Runbook

Date: 2026-04-06  
Status: Active

This runbook validates the complete builder-app onboarding submission path when the Citizen Rust node runtime is already running in the background.

## Goal

Validate that one onboarding submission is handled in two coordinated data paths:

1. **Central database path (off-chain custody):** full onboarding form data is persisted in PostgreSQL.
2. **Citizen network path (on-chain commitment relay):** signed commitment metadata (`walletPayloadHash`, signer DID, signature, algorithm, and scope) is relayed to the configured Citizen endpoint.

## System under test

- `landing-page/frontend` as the app-builder onboarding UI.
- `wallet/browser` as the user-controlled wallet extension (signer UI + key custody).
- `landing-page/backend` as signature verification + persistence + relay orchestrator.
- Citizen runtime endpoint configured through `CITIZEN_SIGNED_SUBMISSION_RELAY_URL`.

## Preconditions

1. Citizen Rust node/API is up and reachable (for example via `http://127.0.0.1:8081`).
2. Landing-page backend is running on `http://127.0.0.1:3001`.
3. Landing-page frontend is running on `http://127.0.0.1:3000`.
4. Browser extension from `wallet/browser` is loaded and enabled for the onboarding origin.
5. Backend environment has relay configured:

```bash
CITIZEN_SIGNED_SUBMISSION_RELAY_URL=http://127.0.0.1:8081/api/v1/your-relay-endpoint
CITIZEN_SIGNED_SUBMISSION_RELAY_MAX_ATTEMPTS=3
CITIZEN_SIGNED_SUBMISSION_RELAY_RETRY_BACKOFF_MS=250
```

## Step 1 — Confirm backend signed-submission contract mode

```bash
curl -sS http://127.0.0.1:3001/interest/signed-submission-contract | jq
```

Expected:

- `submitModel` is `frontend_signed_backend_relay`.
- `relayMode` is either:
  - `database_plus_network_relay` (target mode for this E2E), or
  - `database_only` (valid but does not test blockchain relay).

If `relayMode` is `invalid_relay_configuration`, stop and fix relay URL config first.

## Step 2 — Perform user flow in onboarding UI

1. Open `http://127.0.0.1:3000`.
2. Fill onboarding form fields (`fullName`, `institution`, `email`, `country`, role, mission/need).
3. Click **Sign submission**.
4. In wallet extension prompt:
   - verify origin is the landing-page origin,
   - verify payload preview,
   - approve signature.
5. Click **Submit signed form**.

Expected:

- UI shows success confirmation.
- No unsigned submit fallback is accepted.

## Step 3 — Verify central database custody result

From backend API (admin token may be required depending on deployment policy):

```bash
curl -sS http://127.0.0.1:3001/interest/stats | jq
```

Expected:

- Total submissions increments after your test submit.
- Submission is represented in backend-managed records.

Optional direct SQL verification (container/local DB):

```sql
SELECT
  email,
  wallet_payload_hash,
  wallet_signer_did,
  wallet_algorithm,
  created_at
FROM lead_interest
ORDER BY created_at DESC
LIMIT 5;
```

Expected:

- New row exists for submitted email.
- Wallet metadata columns are populated for the new row.

## Step 4 — Verify Citizen relay + commitment hash path

1. Review backend logs around submit time.
2. Confirm an accepted relay or deterministic relay failure is recorded.

Expected success log characteristics:

- Contains `Relay accepted signed onboarding payload`.
- Includes `trace_id`, `deduplication_key`, `payload_hash`, HTTP status, and attempt count.

If relay fails, expected characteristics:

- Deterministic backend error mentioning Citizen relay reject/unavailable.
- No silent success when relay mode is fail-closed.

## Step 5 — Verify telemetry consistency for this submission

```bash
curl -sS http://127.0.0.1:3001/interest/stats | jq '.relaySubmissionTelemetry'
```

Expected:

- `totalRelaySubmissions` increments when relay mode is enabled.
- `failedRelaySubmissions` increments only for terminal failures.
- `relayDirectSubmitFailureRate` updates as `failedRelaySubmissions / totalRelaySubmissions`.

## Pass criteria

The E2E is considered passed only when **all** are true:

1. Wallet signature was user-approved in extension UI.
2. Backend accepted signed payload and persisted onboarding data in PostgreSQL.
3. Backend attempted relay using deterministic trace + idempotency metadata.
4. Relay completed successfully (or failed deterministically with explicit API error in fail-closed mode).
5. Telemetry reflects the observed relay outcome.

## Evidence template (capture per run)

- UTC timestamp:
- Frontend origin:
- Submitted email:
- `walletPayloadHash`:
- Wallet signer DID:
- Backend HTTP response/status:
- Relay trace ID:
- Relay deduplication key:
- Database row ID/email confirmation:
- `relaySubmissionTelemetry` snapshot:

## Troubleshooting quick map

- **`invalid_relay_configuration` in contract endpoint:** invalid or non-absolute relay URL.
- **`walletPayloadHash does not match walletSigningPayload`:** payload mutation between sign and submit.
- **`walletSignerDid does not match walletVerifyingKey`:** signer metadata mismatch.
- **Relay unavailable/rejected errors:** runtime endpoint down, wrong path, or policy rejection upstream.

