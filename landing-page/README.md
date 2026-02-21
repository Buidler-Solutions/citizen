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

### 2) Run with Docker Compose

```bash
cd landing-page
docker compose up --build
```

App URLs:

- Frontend: `http://localhost:3000`
- Backend API: `http://localhost:3001/interest`
- Lead stats endpoint: `http://localhost:3001/interest/stats`

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
