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
- Site settings support static or animated APNG logo uploads for the landing-page header via the admin console.

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
