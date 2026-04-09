# Citizen Explorer

This folder contains a blockchain explorer application for the Citizen Protocol.

## Structure
- `frontend/` - Next.js frontend
- `backend/` - NestJS API server for fetching Citizen chain data
- `infra/` - Optional infrastructure (PostgreSQL) for relational storage

## Goals
- Fetch canonical data from a Citizen Protocol node/API and present it in a read-only explorer UI.
- Surface deterministic receipt + finality proof data from canonical API responses.
- Provide an extensible backend that can cache or index chain data (PostgreSQL optional).

## Canonical contracts used
Explorer backend now proxies canonical node contracts (no mock fallback payloads):
- `GET /blocks/:height` -> node `GET /blocks/:height`
- `GET /entries/:namespace` -> node `GET /entries/:namespace`
- `GET /entries/:namespace/wallet-signers/:signerDid` -> explorer index view filtered by `payload.payload_wallet_signature.signer` (with legacy fallback to `payload.wallet_signature.signer`)
- `GET /receipts/:receiptId` -> node `GET /api/v1/receipts/:receipt_id`

## Quick start

### Backend
```bash
cd backend
npm install
npm run start:dev
```

Environment variables:
- `CITIZEN_NODE_URL` - base URL to a Citizen node API (defaults to `http://127.0.0.1:8081`).
- `DATABASE_URL` - optional PostgreSQL connection string.

### Frontend
```bash
cd frontend
npm install
npm run dev
```

The explorer frontend runs on `http://localhost:8885` by default.

Environment variables:
- `NEXT_PUBLIC_API_BASE_URL` - base URL for the explorer backend API (defaults to `http://127.0.0.1:3001`).
- `NEXT_PUBLIC_NODE_SOURCE_URL` - fallback node-source label in the UI (defaults to `http://127.0.0.1:8081`).
- `NEXT_PUBLIC_BLOCK_HEIGHT` - block height to inspect (`1` by default).
- `NEXT_PUBLIC_NAMESPACE` - namespace to inspect (`governance.vote` by default).
- `NEXT_PUBLIC_WALLET_SIGNER_DID` - optional signer DID used to query entries by `payload.payload_wallet_signature.signer` (legacy fallback still supported).
- `NEXT_PUBLIC_RECEIPT_ID` - optional deterministic receipt ID for finality proof lookup.

### Postgres (optional)
```bash
cd infra
docker compose up -d
```
