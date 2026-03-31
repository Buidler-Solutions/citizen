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
