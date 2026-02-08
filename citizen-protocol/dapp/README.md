# Citizen DApp (Next.js + NestJS)

This folder contains a demo DApp showcasing Citizen blockchain capabilities with a modern
frontend and backend stack:

- **Frontend**: Next.js (TypeScript)
- **Backend**: NestJS (TypeScript)
- **Database**: PostgreSQL (Docker Compose)

## Getting started

```bash
cd dapp
npm install
```

### Start PostgreSQL

```bash
docker compose up -d
```

### Run backend

```bash
npm run dev:api
```

### Run frontend

```bash
npm run dev:web
```

The web app runs at `http://localhost:3000` and the API at `http://localhost:4000`.

## Environment variables

Copy `.env.example` to `.env` in `apps/api` if you want to enable database health checks.
