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


### Backend
```bash
cd backend
npm install
npm run start:dev
```

The explorer backend is optional and now supports both:
- thin proxy/helper APIs for runtime lookups, and
- an in-memory indexer worker that derives TPS + block/entry weight metrics from runtime blocks.

When running, backend listens on `http://localhost:4444`.

Backend environment variables:
- `PORT` - backend listen port (defaults to `4444`; if occupied and unset, backend falls back to `4445`).
- `CITIZEN_NODE_URL` - runtime API base URL (defaults to `http://127.0.0.1:8081`).
- `INDEXER_POLL_MS` - steady-state indexer polling interval in milliseconds (defaults to `4000`).

Indexer metrics endpoints:
- `GET /metrics/summary`
- `GET /metrics/tps?window=60s&from=&to=` (`window` supports `10s`, `60s`, `5m`, `1h`)
- `GET /metrics/blocks?from_height=&to_height=`
- `GET /metrics/entries?namespace=&entry_ids=<id,id2>&from=&to=`

`GET /metrics/summary` now includes `internal_metrics` snapshots for:
- cumulative retry/failure counters,
- block processing latency (`samples`, `avg`, `p95`, `max`, `last` in ms),
- aggregation-job latency (`samples`, `avg`, `p95`, `max`, `last` in ms),
- and ingestion lag (in blocks).

### Frontend
```bash
cd frontend
npm install
npm run dev
```

The explorer frontend runs on `http://localhost:8885` by default.

Dashboard prefers explorer-backend indexer metrics when `NEXT_PUBLIC_EXPLORER_BACKEND_URL` is reachable, and falls back to frontend-local derivation when backend metrics are unavailable.
Blocks list and block detail screens label metric provenance explicitly (`runtime`, `indexer`, or `fallback`) and keep rendering with deterministic runtime/local weight computation when indexer metrics are unavailable.

Environment variables:
- `NEXT_PUBLIC_EXPLORER_BACKEND_URL` - explorer backend base URL (defaults to `http://127.0.0.1:4444`).
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
