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

### 2) Create environment file

```bash
cd landing-page
cp .env.example .env
```

Update `JWT_SECRET` and `JWT_ADMIN_KEY` before non-local use.

### 3) Run with Docker Compose

```bash
cd landing-page
docker compose up --build
```

App URLs:

- Frontend: `http://localhost:3000`
- Backend API: `http://localhost:3001/interest`
- Lead stats endpoint (JWT protected): `http://localhost:3001/interest/stats`

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
