# Citizen Government Adoption Landing Page

This folder contains a pitch-driven full-stack landing page implementation based on:

- `citizen-protocol/docs/GOVERNMENT_ADOPTION_PITCH.md`

## Stack

- **Frontend:** Next.js (App Router)
- **Backend:** NestJS + TypeORM
- **Database:** PostgreSQL

## Quick Start

### 1) Install dependencies

```bash
cd landing-page/frontend && npm install
cd ../backend && npm install
```

## Run Locally (without Docker)

### 1) Create local environment files

```bash
cp landing-page/frontend/.env.local.example landing-page/frontend/.env.local
cp landing-page/backend/.env.example landing-page/backend/.env
```

Update `JWT_SECRET` and `JWT_ADMIN_KEY` before non-local use.

### 2) Start backend

```bash
cd landing-page/backend
npm run start:dev
```

### 3) Start frontend

```bash
cd landing-page/frontend
npm run dev
```

App URLs:

- Frontend: `http://localhost:3000`
- Backend API: `http://localhost:3001/interest`
- Lead stats endpoint (JWT protected): `http://localhost:3001/interest/stats`
- Admin login UI: `http://localhost:3000/admin/login`
- Admin dashboard UI: `http://localhost:3000/admin/dashboard`

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

1. Request a token with the admin key:

```bash
curl -X POST http://localhost:3001/auth/token \
  -H 'Content-Type: application/json' \
  -d '{"adminKey":"change-me-admin-key","subject":"ops-user"}'
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
