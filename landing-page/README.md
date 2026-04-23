# Citizen Government Adoption Landing Page

This folder contains a pitch-driven full-stack landing page implementation based on:

- `citizen-protocol/docs/GOVERNMENT_ADOPTION_PITCH.md`

All workspace commands should be run from the `landing-page/` directory with `pnpm`.

## Stack

- **Frontend:** Next.js (App Router)
- **Backend:** NestJS + TypeORM
- **Database:** PostgreSQL

## Quick Start

### 1) Install dependencies

```bash
cd landing-page
pnpm install
```

## Run Locally (without Docker)

### 1) Create local environment files

```bash
cp landing-page/frontend/.env.local.example landing-page/frontend/.env.local
cp landing-page/backend/.env.example landing-page/backend/.env
```

Update `JWT_SECRET`, `ADMIN_USERNAME`, and `ADMIN_PASSWORD` before non-local use.

### 2) Start services from the workspace root

```bash
cd landing-page
pnpm run dev
```

This starts both the frontend and backend from the `landing-page/` folder.

### 3) Start a single service when needed

```bash
cd landing-page
pnpm run backend:dev
pnpm run frontend:dev
```

Additional root commands:

```bash
pnpm run build
pnpm run lint
pnpm run backend:start
pnpm run frontend:start
```

App URLs:

- Frontend: `http://localhost:3000`
- Backend API: `http://localhost:3001/interest`
- Lead stats endpoint (JWT protected): `http://localhost:3001/interest/stats`
- Admin login UI: `http://localhost:3000/admin/login`
- Admin dashboard UI: `http://localhost:3000/admin/dashboard`
- Admin email settings API (JWT protected): `http://localhost:3001/admin/email/smtp-settings`
- Admin email templates API (JWT protected): `http://localhost:3001/admin/email/templates`
- Admin onboarding update preview/send API (JWT protected): `http://localhost:3001/admin/email/onboarding-updates/preview` and `http://localhost:3001/admin/email/onboarding-updates/send`
- Admin notification audit history API (JWT protected): `http://localhost:3001/admin/email/notifications/history?limit=25`
- Admin reset-password UI: `http://localhost:3000/admin/reset-password`
- Site settings support static or animated APNG logo uploads for the landing-page header via the admin console.
- Onboarding wallet login uses the wallet auth backend (`POST /auth/challenge` + `POST /auth/verify`) and defaults to `http://127.0.0.1:4499`.

### Wallet login integration (onboarding)

The onboarding page now uses the `wallet/sdk/typescript-auth` library and Citizen wallet login flow directly from the landing-page frontend:

1. Connect wallet with `ctzn_requestAccounts`.
2. Request backend challenge from `${NEXT_PUBLIC_WALLET_AUTH_API_URL}/auth/challenge`.
3. Sign challenge with `personal_sign`.
4. Verify with `${NEXT_PUBLIC_WALLET_AUTH_API_URL}/auth/verify`.
5. Store session token in browser local storage for onboarding session continuity.

Set this frontend environment variable when your wallet auth backend runs on a different host:

```bash
NEXT_PUBLIC_WALLET_AUTH_API_URL=http://127.0.0.1:4499
```

Notes:

- There is no frontend env var to "connect" to the browser extension itself; the extension injects `window.citizen` / `window.ctzn` into the page when installed and enabled.
- The backend must allow your frontend origin via `AUTH_ALLOWED_ORIGINS` in `wallet/backend/.env`.


## Wallet-system tech-stack context for app-builder flows

For onboarding/form workflows, the landing page is one part of the broader wallet system stack:

- `landing-page` (builder app UX + backend integration)
- `wallet/browser` (user-controlled signing + local custody surface)
- `sdk/typescript` (builder integration helpers)
- `citizen-protocol` runtime APIs (canonical envelopes/receipts/finality)
- wallet CLI/runtime crate (`citizen-protocol/crates/wallet`) for reference signing parity

Recommended pattern for sensitive form data:
1. collect form fields client-side,
2. request `ctzn_signCitizenTx` from the extension,
3. submit signed envelope/commitment (`payloadHash`) to backend,
4. anchor commitments/receipts to chain via runtime APIs.

This keeps raw user data out of direct unauthenticated builder-server form posts while preserving deterministic verification.

The onboarding form now enforces this sequence: backend submission is accepted only with wallet signature metadata (`walletSignerDid`, `walletVerifyingKey`, `walletSignature`, `walletPayloadHash`, `walletSigningPayload`, `walletAlgorithm`). Direct unsigned form submissions are rejected, and backend cryptographically verifies Ed25519 signature validity plus DID/verifying-key consistency before writing to PostgreSQL.
At the final onboarding step, the action is intentionally two-phase:
1) **Sign submission** (opens wallet and signs payload), then
2) **Submit signed form** (persists to backend and optional relay).

Relay behavior is exposed as an explicit API contract at `GET /interest/signed-submission-contract` so frontend copy and consent text can accurately state whether submissions are backend-only, backend+Citizen-relay, or blocked by invalid relay configuration.

To relay signed-hash metadata into the Citizen network from backend:

```bash
CITIZEN_SIGNED_SUBMISSION_RELAY_URL=http://127.0.0.1:8081/api/v1/your-relay-endpoint
CITIZEN_SIGNED_SUBMISSION_RELAY_FORMAT=metadata
CITIZEN_SIGNED_SUBMISSION_RELAY_MAX_ATTEMPTS=3
CITIZEN_SIGNED_SUBMISSION_RELAY_RETRY_BACKOFF_MS=250
```

`CITIZEN_SIGNED_SUBMISSION_RELAY_FORMAT` controls payload shape:

- `metadata` (default): sends onboarding metadata contract (for dedicated relay adapters).
- `runtime_envelope`: sends a Citizen runtime `SignedEnvelope<LedgerEntry>` request body directly to `/api/v1/envelopes/submit`.

When using `runtime_envelope`, optionally override these defaults to match your validator namespace policy:

```bash
CITIZEN_SIGNED_SUBMISSION_RUNTIME_AUTHOR=forms.commitment
CITIZEN_SIGNED_SUBMISSION_RUNTIME_NAMESPACE=forms.commitment
CITIZEN_SIGNED_SUBMISSION_RUNTIME_ACTION=SUBMIT_ONBOARDING_INTEREST
CITIZEN_SIGNED_SUBMISSION_RUNTIME_SIGNING_PRIVATE_KEY_PEM="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----"
# Optional guardrails (defaults shown)
CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_MODE=hybrid
# CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_FLAG=false
# Required when privacy_mode=hybrid
CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHORIZED_READERS=did:reader:ops,did:reader:audit
# Optional hybrid controls
# CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_POLICY_REF=policy:onboarding:hybrid:v1
# CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_CONSENT_TTL_SECONDS=31536000
# CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_WRAP_ALGORITHM=sha256-reader-salted-wrap-v1
```

`runtime_envelope` mode requires `CITIZEN_SIGNED_SUBMISSION_RUNTIME_SIGNING_PRIVATE_KEY_PEM` (Ed25519 PKCS#8 PEM). The backend signs canonical runtime entry payloads with this key so Rust runtime namespace policies can validate signatures deterministically.
Onboarding runtime relay now supports `privacy_mode=hybrid` and generates runtime envelope privacy fields (`ciphertext_hex`, `nonce_hex`, `payload_commitment`, `authorized_readers`, `key_wrapped_secrets`, `consent_receipt`) from onboarding signed payload metadata. `privacy_mode=passphrase` remains unsupported in this flow and fails closed.
When relay returns non-2xx, backend errors now include upstream `detail/error/message` snippets from runtime responses to help diagnose namespace/policy mismatches.

### Runtime privacy options (comprehensive)

Citizen runtime ledger entries support these privacy modes:

| privacy_mode | privacy_flag | What it means | Required runtime fields (ledger-level) | Onboarding relay status |
| --- | --- | --- | --- | --- |
| `none` | `false` | Public/cleartext payload path (no encrypted envelope fields). | No encryption fields required. | ✅ Supported (legacy/default compatibility). |
| `passphrase` | `true` | Single-holder encrypted payload where one-time passphrase-derived key decrypts data. | `ciphertext_hex`, `nonce_hex`, `payload_commitment`, plus `salt_hex` and `kdf_params`, and a matching `consent_receipt`. | ❌ Not supported by current onboarding relay payload builder. |
| `hybrid` | `true` | Shared encrypted payload path using wrapped DEKs for authorized readers (and optional field ACL metadata). | `ciphertext_hex`, `nonce_hex`, `payload_commitment`, non-empty `key_wrapped_secrets`, matching reader/wrap coherence, and a matching `consent_receipt`. | ✅ **Supported now** for onboarding runtime relay when `CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHORIZED_READERS` is configured. |

Why onboarding now prefers `hybrid`:

1. The onboarding relay already submits **commitment metadata** (`data_hash`, `encrypted_form_url`) and wallet signature evidence; hybrid mode now wraps that signed onboarding payload into encrypted envelope fields for runtime policy compatibility.
2. Hybrid mode enables explicit authorized-reader metadata (`authorized_readers`, `key_wrapped_secrets`) and an embedded consent receipt shape expected by runtime privacy checks.
3. Full form custody remains off-chain (`interest_submissions://...`) while on-chain entries carry deterministic privacy metadata and commitments.

Operational guidance:

- Prefer `CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_MODE=hybrid` and set `CITIZEN_SIGNED_SUBMISSION_RUNTIME_HYBRID_AUTHORIZED_READERS` to governed reader DIDs.
- Only set `CITIZEN_SIGNED_SUBMISSION_RUNTIME_PRIVACY_FLAG` if you need explicit guardrail checks; when set, it must match the mode (`true` for `hybrid`, `false` for `none`).
- `privacy_mode=passphrase` remains intentionally blocked in onboarding runtime relay; use wallet/CLI encrypt-then-commit workflows when passphrase mode is required.

If `CITIZEN_SIGNED_SUBMISSION_RELAY_URL` is configured, onboarding writes fail when relay submission fails, so PostgreSQL and network relay remain synchronized per request.
The relay URL is fail-closed validated on submit: it must be an absolute `http://` or `https://` URL (invalid values are rejected before persistence).

Relay delivery uses deterministic deduplication keys derived from `(walletPayloadHash, email)` and sends the key in `deduplication_key` and `x-idempotency-key` so upstreams can safely collapse duplicates.
Retry behavior is bounded and configurable: transient relay failures (`429`, `5xx`, or network errors) are retried up to `CITIZEN_SIGNED_SUBMISSION_RELAY_MAX_ATTEMPTS` with exponential backoff starting at `CITIZEN_SIGNED_SUBMISSION_RELAY_RETRY_BACKOFF_MS` milliseconds.
Protected stats responses from `GET /interest/stats` now include `relaySubmissionTelemetry.relayDirectSubmitFailureRate`, computed from terminal relay outcomes (`failedRelaySubmissions / totalRelaySubmissions`) when relay mode is enabled.

Migration note: existing `interest_submissions` rows created before wallet-signing enforcement are preserved with nullable wallet metadata columns; new submissions are still enforced at request-validation/service level.

## Run with Docker Compose

### 1) Create Docker environment file

```bash
cd landing-page
cp .env.example .env
```

### 2) Start containers

```bash
cd landing-page
docker compose up --build
```

## JWT Setup

1. Request a token with the admin username and password:

```bash
curl -X POST http://localhost:3001/auth/token \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"change-me-admin-password","subject":"ops-user"}'
```

2. Use the returned `accessToken` as a bearer token to query stats:

```bash
curl http://localhost:3001/interest/stats \
  -H "Authorization: Bearer <accessToken>"
```

## API Payload

`POST /interest`

```json
{
  "fullName": "Jane Doe",
  "institution": "Ministry of Public Administration",
  "email": "jane.doe@gov.example",
  "country": "Kenya",
  "missionNeed": "National procurement audit trail with independent public verification"
}
```

## Asciinema Docs

- How-to (install + record): `landing-page/howtos/installing-asciinema-for-recording.md`
- Runbook (upload + shortcode): `landing-page/runbook/asciinema-admin-upload-and-onboarding-shortcode.md`
- Runbook (email architecture checkpoint): `landing-page/runbook/onboarding-email-notification-checkpoint.md`
- Runbook (wallet-signed onboarding E2E): `landing-page/runbook/wallet-signed-onboarding-e2e.md`

## Email + password reset environment additions

The onboarding email workflows support these additional backend environment variables:

```bash
NODE_ENV=development
SMTP_REQUIRED=false
ADMIN_EMAIL=ops@example.gov
ONBOARDING_SUPPORT_EMAIL=support@example.gov
ONBOARDING_NOTIFICATION_EMAILS=ops@example.gov;audit@example.gov
ONBOARDING_ADMIN_DASHBOARD_URL=http://localhost:3000/admin/dashboard
ONBOARDING_RESET_PASSWORD_URL=http://localhost:3000/admin/reset-password
ONBOARDING_ADMIN_LOGIN_URL=http://localhost:3000/admin/login
PASSWORD_RESET_TTL_MINUTES=60
ONBOARDING_UPDATE_QUEUE_THRESHOLD=25
ONBOARDING_UPDATE_SYNC_LIMIT=100
```

## SMTP transport validation

- The backend validates SMTP readiness during boot through the shared mail service.
- In development, missing SMTP settings or an unavailable transporter package degrade safely to log-only delivery.
- In production, or whenever `SMTP_REQUIRED=true`, the backend fails fast if the resolved SMTP host/from-address pair is incomplete or if the runtime cannot load the Nodemailer transport package.
- The admin email center also surfaces the current transport mode and validation issues from `GET /admin/email/smtp-settings`.

## Onboarding update delivery mode

- Phase 1 onboarding update broadcasts execute synchronously in the API request cycle.
- The admin email center now surfaces the current synchronous-inline execution plan, including when queue-backed delivery is recommended.
- `ONBOARDING_UPDATE_QUEUE_THRESHOLD` controls when the UI/API warn operators that a queue worker should take over for broader sends.
- `ONBOARDING_UPDATE_SYNC_LIMIT` sets the hard per-request recipient cap for inline delivery; larger audiences are rejected until a worker/queue path exists.
