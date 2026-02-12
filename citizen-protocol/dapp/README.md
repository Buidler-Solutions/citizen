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

If unset, the API uses placeholder `.invalid` URLs and submissions will fail until configured.

### Run backend with explicit network targets

```bash
cd citizen-protocol/dapp/apps/api
CITIZEN_TESTNET_SUBMIT_URL=https://testnet.your-citizen-node/api/v1/entries/submit \
CITIZEN_FUTURENET_SUBMIT_URL=https://futurenet.your-citizen-node/api/v1/entries/submit \
CITIZEN_MAINNET_SUBMIT_URL=https://mainnet.your-citizen-node/api/v1/entries/submit \
npm run start:dev
```

From the web app, pick the target network in the publisher UI, then sign + submit.

### About local demo server vs network endpoints

`demo/server.js` remains available for local prototyping, but the DApp API now models
real network target selection through testnet/futurenet/mainnet endpoint configuration.

