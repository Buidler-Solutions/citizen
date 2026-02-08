# Citizen Explorer

This folder contains a blockchain explorer application for the Citizen Protocol.

## Structure
- `frontend/` - Next.js frontend
- `backend/` - NestJS API server for fetching Citizen chain data
- `infra/` - Optional infrastructure (PostgreSQL) for relational storage

## Goals
- Fetch data from a Citizen Protocol node/API and present it in a read-only explorer UI.
- Provide an extensible backend that can cache or index chain data (PostgreSQL optional).

## Quick start

### Backend
```bash
cd backend
npm install
npm run start:dev
```

Environment variables (see `backend/.env.example`):
- `CITIZEN_NODE_URL` - base URL to a Citizen node API.
- `DATABASE_URL` - optional PostgreSQL connection string.

### Frontend
```bash
cd frontend
npm install
npm run dev
```

Environment variables (see `frontend/.env.example`):
- `NEXT_PUBLIC_API_BASE_URL` - base URL for the backend API.

### Postgres (optional)
```bash
cd infra
docker compose up -d
```

