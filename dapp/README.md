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


## Node submission integration

Wallet-signed article publishing in `apps/web` + `apps/api` supports selecting a blockchain
network target: **testnet**, **futurenet**, or **mainnet**.

### Configure network submit endpoints

Set these in your API environment:

- `CITIZEN_TESTNET_SUBMIT_URL`
- `CITIZEN_FUTURENET_SUBMIT_URL`
- `CITIZEN_MAINNET_SUBMIT_URL`

If unset, the API defaults to local validator trio endpoints on `127.0.0.1:8081-8083`.

### Run backend with explicit network targets

```bash
cd dapp/apps/api
CITIZEN_TESTNET_SUBMIT_URL=https://testnet.your-citizen-node/api/v1/envelopes/submit \
CITIZEN_FUTURENET_SUBMIT_URL=https://futurenet.your-citizen-node/api/v1/envelopes/submit \
CITIZEN_MAINNET_SUBMIT_URL=https://mainnet.your-citizen-node/api/v1/envelopes/submit \
npm run start:dev
```

From the web app, pick the target network in the publisher UI, then sign + submit.

### About local demo server vs network endpoints

`demo/server.js` remains available for local prototyping, but the DApp API now models
real network target selection through testnet/futurenet/mainnet endpoint configuration.


## Wallet ↔ Node connectivity (important)

The browser extension wallet does **not** connect directly to Rust validator nodes.
The integration path is:

1. Web app (`apps/web`) asks injected wallet provider for account + `personal_sign`
2. Browser wallet extension signs challenge and returns signature to the web app
3. Web app sends signature to DApp API (`apps/api`)
4. DApp API verifies signature with `ethers::verifyMessage`
5. DApp API wraps the signed ledger entry in a canonical envelope and submits it to the configured network endpoint using the Node.js SDK client (`@citizen-protocol/nodejs-sdk`) for runtime endpoints

### Current state of Rust node API

The Rust `crates/api` service now supports canonical envelope submission and query routes:

- `GET /health`
- `GET /blocks/:height`
- `GET /namespaces`
- `GET /entries/:namespace`
- `POST /api/v1/envelopes/submit`

The submit route accepts a canonical `SignedEnvelope<LedgerEntry>` payload and returns a deterministic receipt that can be retrieved via `GET /api/v1/receipts/:receipt_id`.

### Minimum configuration to make publish flow work against local Rust nodes

Run localnet first (`scripts/run_localnet.sh`) so node APIs are available at ports `8081-8083`.
The DApp API defaults already target those local Rust node endpoints:

- `testnet` → `http://127.0.0.1:8081/api/v1/envelopes/submit`
- `futurenet` → `http://127.0.0.1:8082/api/v1/envelopes/submit`
- `mainnet` → `http://127.0.0.1:8083/api/v1/envelopes/submit`

Optional override:

```bash
cd dapp/apps/api
CITIZEN_TESTNET_SUBMIT_URL=http://127.0.0.1:8081/api/v1/envelopes/submit CITIZEN_FUTURENET_SUBMIT_URL=http://127.0.0.1:8082/api/v1/envelopes/submit CITIZEN_MAINNET_SUBMIT_URL=http://127.0.0.1:8083/api/v1/envelopes/submit npm run start:dev
```


