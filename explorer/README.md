# Citizen Explorer

This folder contains a blockchain explorer application for the Citizen Protocol.

## Structure
- `frontend/` - Next.js frontend
- `infra/` - Optional infrastructure (PostgreSQL) for relational storage

## Goals
- Fetch canonical data from a Citizen Protocol node/API and present it in a read-only explorer UI.
- Surface deterministic receipt + finality proof data from canonical API responses.
- Optionally add relational indexing infrastructure for analytics workflows (PostgreSQL optional).

## Canonical contracts used
Explorer frontend now calls canonical node/runtime contracts directly:
- `GET /blocks?cursor=<height>&limit=<n>` -> node/runtime deterministic descending pagination (`items`, `next_cursor`, `has_more`)
- `GET /blocks/:height` -> node `GET /blocks/:height`
- `GET /entries/:namespace` -> node `GET /entries/:namespace`
- `GET /entries/:namespace/wallet-signers/:signerDid` -> node/runtime route when enabled by the current runtime build
- `GET /receipts/:receiptId` -> node/runtime route

## Quick start

### Frontend
```bash
cd frontend
npm install
npm run dev
```

The explorer frontend runs on `http://localhost:8885` by default.

Environment variables:
- `NEXT_PUBLIC_NODE_RUNTIME_URL` - base URL for the Citizen node runtime API (defaults to `http://127.0.0.1:8081`).
- `NEXT_PUBLIC_BLOCK_HEIGHT` - block height to inspect (`1` by default).
- `NEXT_PUBLIC_NAMESPACE` - namespace to inspect (`governance.vote` by default).
- `NEXT_PUBLIC_WALLET_SIGNER_DID` - optional signer DID used to query entries by `payload.payload_wallet_signature.signer` (legacy fallback still supported).
- `NEXT_PUBLIC_RECEIPT_ID` - optional deterministic receipt ID for finality proof lookup.

### Postgres (optional)
```bash
cd infra
docker compose up -d
```
